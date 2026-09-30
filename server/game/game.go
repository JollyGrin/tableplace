package game

import (
	"encoding/json"
	"time"

	"github.com/jollygrin/tts-server/jsonmerge"
	"github.com/rs/zerolog/log"
)

// HandleMessage handles incoming messages from players
// If a message is returned, send it back to the caller.
// TODO: Make this a channel and async go routine
func (g *Game) HandleMessage(from *Player, msg Message) {
	if msg.PlayerID == "" {
		// This feels like a bug futher up and should not be fixed here.
		msg.PlayerID = from.ID
	}

	switch msg.Type {
	case "sync":
		g.SyncPlayerState(from.ID)
		return
	case "connect":
		// join handshake — presence is broadcast from ConnectPlayer, so there
		// is nothing to relay and no client handles this type anymore
		return
	case "update":
		g.update(msg)
	case "camera":
		// Ephemeral tier (SPEC.md §4c). Presence-only traffic — remote camera
		// poses today. Deliberately does NOT touch g.Data: it must never be
		// persisted, never appear in a `sync` snapshot and never replay to a
		// joiner. Falling straight through to the broadcast below *is* the
		// contract; this case exists so nobody "fixes" it into an update.
	case "journal":
		// Ephemeral tier as well: one action-journal line per player action
		// (tableplace-201). The change itself already rode its own "update";
		// this is only the log line, so it is relayed and forgotten exactly
		// like "camera" — never merged, never in a sync, never replayed.
	case "ping":
		// Ephemeral tier again: a player pointing at a table spot
		// (tableplace-198). Sent once per gesture and rate-limited by the
		// client; relayed and forgotten, never merged, synced or replayed.
	}

	// For whatever reason, we broadcast every message.
	// This feels.... wrong
	data, _ := json.Marshal(msg)
	g.out <- &PlayerMessage{ // TODO: Full channel problems
		To:      []string{},
		Exclude: from.ID,
		Content: data,
	}
}

func (g *Game) SyncPlayerState(id string) {
	// marshal under the lock, send after releasing it — sending to a possibly
	// full channel while holding the state mutex can deadlock the lobby
	g.mu.Lock()
	data, err := json.Marshal(g.Data)
	g.mu.Unlock()
	if err != nil {
		log.Err(err).Msg("Failed to marshal state for sync")
		return
	}

	returnMsg := &Message{
		Type:      "sync",
		PlayerID:  id, // TODO: should be a server id or something
		Timestamp: time.Now().UnixMilli(),
		Value:     data,
	}
	payload, _ := json.Marshal(returnMsg)

	g.out <- &PlayerMessage{
		To:      []string{id},
		Content: payload,
	}
}

// DisconnectPlayer marks the player's socket as gone. The offline broadcast is
// deferred by the grace period: a page refresh or brief network blip reconnects
// the same player id within seconds, and the other clients should never see a
// flicker. Only if the player is still gone when the timer fires does the
// lobby learn about it.
//
// Called from lobby.unsubscribe while holding the lobby mutex — nothing here
// may send on g.out (the lobby's run loop needs that same mutex to drain it).
func (g *Game) DisconnectPlayer(p *Player) {
	g.mu.Lock()
	defer g.mu.Unlock()

	p.conns--
	if p.conns > 0 {
		// another live socket for the same player id (overlapping reconnect) —
		// the player is still connected, nothing to schedule
		return
	}
	p.conns = 0
	p.Connected = false

	id := p.ID
	if t, ok := g.offlineTimers[id]; ok {
		t.Stop()
	}
	g.offlineTimers[id] = time.AfterFunc(g.offlineGrace, func() {
		g.broadcastOffline(id)
	})
}

// broadcastOffline runs when a disconnect grace period expires. If the player
// reconnected in the meantime, it does nothing.
func (g *Game) broadcastOffline(id string) {
	g.mu.Lock()
	delete(g.offlineTimers, id)
	p, ok := g.Players[id]
	if !ok || p.Connected {
		g.mu.Unlock()
		return
	}
	payload := g.mergePresenceLocked(id, false)
	g.mu.Unlock()
	g.sendPresence(payload)
}

func (g *Game) ConnectPlayer(playerID string) *Player {
	g.mu.Lock()
	g.LastActivity = time.Now()

	// reconnect inside the grace period: the offline patch was never sent, so
	// cancel it and nobody ever learns the player was gone
	if t, ok := g.offlineTimers[playerID]; ok {
		t.Stop()
		delete(g.offlineTimers, playerID)
	}

	player, ok := g.Players[playerID]
	if !ok {
		player = &Player{
			ID:            playerID,
			JoinTimestamp: time.Now().UnixMilli(),
			Seat:          0,
		}
		g.Players[playerID] = player
	}
	player.conns++
	player.Connected = true

	payload := g.mergePresenceLocked(playerID, true)
	g.mu.Unlock()

	// send outside the lock — a full channel while holding g.mu can deadlock
	g.sendPresence(payload)
	return player
}

// mergePresenceLocked merges {"players": {id: {"connected": v}}} into g.Data
// and returns the marshaled update message to broadcast. Caller must hold g.mu.
//
// The patch may create a partial row for an id not yet in g.Data.players (the
// socket attaches before the client sends any player data); the HUD skips rows
// without a joinTimestamp, so such rows are never rendered.
func (g *Game) mergePresenceLocked(playerID string, connected bool) []byte {
	patch := map[string]any{
		"players": map[string]any{playerID: map[string]any{"connected": connected}},
	}
	g.Data = jsonmerge.MergeMaps(g.Data, patch)
	g.Updates++

	value, err := json.Marshal(patch)
	if err != nil {
		log.Err(err).Msg("Failed to marshal presence patch")
		return nil
	}
	msg := Message{
		Type:      "update",
		PlayerID:  playerID,
		Timestamp: time.Now().UnixMilli(),
		Value:     value,
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		log.Err(err).Msg("Failed to marshal presence message")
		return nil
	}
	return payload
}

// sendPresence broadcasts a presence update to the whole lobby without ever
// blocking: DisconnectPlayer's timer can fire after the lobby stopped draining
// g.out, and a stuck send there would leak the goroutine. Dropping a presence
// patch on a full channel is harmless — the next sync carries the same state.
func (g *Game) sendPresence(payload []byte) {
	if payload == nil {
		return
	}
	select {
	case g.out <- &PlayerMessage{To: []string{}, Content: payload}:
	default:
		log.Warn().Msg("game out channel full, dropping presence update")
	}
}

func (g *Game) update(msg Message) {
	if msg.Value == nil {
		log.Error().Msgf("Invalid update message: missing path or value")
		return
	}

	// decode outside the lock; only the merge itself needs exclusivity
	var patch map[string]any
	if err := json.Unmarshal(msg.Value, &patch); err != nil {
		log.Err(err).Msg("Failed to decode update value")
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()
	g.Data = jsonmerge.MergeMaps(g.Data, patch)
	g.Updates++
	g.LastActivity = time.Now()
}
