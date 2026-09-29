package game

import (
	"encoding/json"
	"testing"
	"time"
)

// nextOfType drains the out channel until a message of the given type shows up.
// ConnectPlayer broadcasts a presence update of its own (#48), so a camera
// relay is never the first thing on the channel.
func nextOfType(t *testing.T, out <-chan *PlayerMessage, want string) (*PlayerMessage, Message) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case pm := <-out:
			var m Message
			if err := json.Unmarshal(pm.Content, &m); err != nil {
				t.Fatalf("undecodable broadcast: %v", err)
			}
			if m.Type == want {
				return pm, m
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a %q broadcast", want)
		}
	}
}

func drain(out <-chan *PlayerMessage) {
	for {
		select {
		case <-out:
		default:
			return
		}
	}
}

// The ephemeral tier (SPEC.md §4c): `camera` messages are relayed to peers but
// must never touch the canonical state — no persistence, nothing in `sync`,
// nothing replayed to a joiner.
//
// Note this is a stronger claim than "g.Data is empty": #48's presence path
// legitimately writes players[id].connected on attach, so the test pins the
// state *before* the camera traffic and requires it to be byte-identical after.
func TestCameraMessageIsRelayedButNeverMerged(t *testing.T) {
	g, out := NewGame()
	alice := g.ConnectPlayer("alice")
	drain(out) // alice's presence patch

	g.mu.Lock()
	before, _ := json.Marshal(g.Data)
	updatesBefore := g.Updates
	g.mu.Unlock()

	g.HandleMessage(alice, Message{
		Type:      "camera",
		PlayerID:  "alice",
		Timestamp: time.Now().UnixMilli(),
		Value:     json.RawMessage(`{"p":[0,25,0],"t":[0,0,0],"seq":1}`),
	})

	broadcast, relayed := nextOfType(t, out, "camera")
	if broadcast.Exclude != "alice" {
		t.Fatalf("camera message should be relayed to everyone but the sender, got exclude=%q", broadcast.Exclude)
	}
	if len(broadcast.To) != 0 {
		t.Fatalf("camera message should go to the whole lobby, got to=%v", broadcast.To)
	}
	var value map[string]any
	if err := json.Unmarshal(relayed.Value, &value); err != nil {
		t.Fatalf("relayed value is not an object: %v", err)
	}
	if value["seq"] != float64(1) {
		t.Fatalf("relayed payload lost its seq: %v", value)
	}

	g.mu.Lock()
	after, _ := json.Marshal(g.Data)
	updatesAfter := g.Updates
	g.mu.Unlock()

	if string(before) != string(after) {
		t.Fatalf("camera message mutated game state:\n before %s\n after  %s", before, after)
	}
	if updatesAfter != updatesBefore {
		t.Fatalf("camera message counted as a state update: %d → %d", updatesBefore, updatesAfter)
	}
}

// A joiner's sync snapshot is g.Data — so if camera never merges, it can never
// appear there. Presence *is* expected in the snapshot; camera poses are not.
func TestSyncSnapshotContainsNoCameraData(t *testing.T) {
	g, out := NewGame()
	alice := g.ConnectPlayer("alice")

	g.HandleMessage(alice, Message{
		Type:     "update",
		PlayerID: "alice",
		Value:    json.RawMessage(`{"cards":{"card:1":{"position":[1,2,3]}}}`),
	})

	for seq := 1; seq <= 10; seq++ {
		g.HandleMessage(alice, Message{
			Type:     "camera",
			PlayerID: "alice",
			Value:    json.RawMessage(`{"p":[0,25,0],"t":[0,0,0],"seq":7}`),
		})
	}
	drain(out)

	g.SyncPlayerState("bob")
	_, msg := nextOfType(t, out, "sync")

	var state map[string]any
	if err := json.Unmarshal(msg.Value, &state); err != nil {
		t.Fatalf("sync value is not an object: %v", err)
	}
	if _, ok := state["cards"]; !ok {
		t.Fatalf("sync lost the real state: %v", state)
	}
	// presence is supposed to be here — that is #48's channel, not ours
	if _, ok := state["players"]; !ok {
		t.Fatalf("sync lost presence state: %v", state)
	}
	for _, key := range []string{"camera", "cameras", "p", "t", "seq"} {
		if _, ok := state[key]; ok {
			t.Fatalf("sync snapshot contains camera data under %q: %v", key, state)
		}
	}
	// and nothing camera-shaped hid inside a player row
	raw, _ := json.Marshal(state["players"])
	for _, needle := range []string{`"seq"`, `"p":[`, `"t":[`} {
		if bytesContains(raw, needle) {
			t.Fatalf("camera data leaked into a player row: %s", raw)
		}
	}
}

func bytesContains(haystack []byte, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		json.Valid(haystack) && containsSub(string(haystack), needle)
}

func containsSub(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// The action journal (tableplace-201) rides the same ephemeral tier: a
// `journal` line is relayed to peers and forgotten — never merged into the
// state a joiner's sync is built from.
func TestJournalMessageIsRelayedButNeverMerged(t *testing.T) {
	g, out := NewGame()
	alice := g.ConnectPlayer("alice")
	drain(out)

	g.mu.Lock()
	before, _ := json.Marshal(g.Data)
	updatesBefore := g.Updates
	g.mu.Unlock()

	g.HandleMessage(alice, Message{
		Type:      "journal",
		PlayerID:  "alice",
		Timestamp: time.Now().UnixMilli(),
		Value:     json.RawMessage(`{"id":"alice:1","actor":"alice","verb":"move","targets":[{"kind":"piece","id":"piece:alice:a","name":"A"}],"at":1}`),
	})

	broadcast, relayed := nextOfType(t, out, "journal")
	if broadcast.Exclude != "alice" || len(broadcast.To) != 0 {
		t.Fatalf("journal line should go to everyone but the sender, got to=%v exclude=%q", broadcast.To, broadcast.Exclude)
	}
	var value map[string]any
	if err := json.Unmarshal(relayed.Value, &value); err != nil || value["verb"] != "move" {
		t.Fatalf("relayed journal line lost its payload: %s (%v)", relayed.Value, err)
	}

	g.mu.Lock()
	after, _ := json.Marshal(g.Data)
	updatesAfter := g.Updates
	g.mu.Unlock()
	if string(before) != string(after) || updatesAfter != updatesBefore {
		t.Fatalf("journal line touched game state:\n before %s\n after  %s", before, after)
	}
}

// A ping (tableplace-198) is the same ephemeral tier: relayed to everyone but
// the sender with its point intact, and never merged into the state a joiner's
// sync is built from.
func TestPingMessageIsRelayedButNeverMerged(t *testing.T) {
	g, out := NewGame()
	alice := g.ConnectPlayer("alice")
	g.ConnectPlayer("bob")
	drain(out)

	g.mu.Lock()
	before, _ := json.Marshal(g.Data)
	updatesBefore := g.Updates
	g.mu.Unlock()

	g.HandleMessage(alice, Message{
		Type:      "ping",
		PlayerID:  "alice",
		Timestamp: time.Now().UnixMilli(),
		Value:     json.RawMessage(`{"x":3.5,"z":-2}`),
	})

	broadcast, relayed := nextOfType(t, out, "ping")
	if broadcast.Exclude != "alice" || len(broadcast.To) != 0 {
		t.Fatalf("ping should go to everyone but the sender, got to=%v exclude=%q", broadcast.To, broadcast.Exclude)
	}
	var value map[string]float64
	if err := json.Unmarshal(relayed.Value, &value); err != nil || value["x"] != 3.5 || value["z"] != -2 {
		t.Fatalf("relayed ping lost its point: %s (%v)", relayed.Value, err)
	}
	if relayed.PlayerID != "alice" {
		t.Fatalf("relayed ping lost its sender: %q", relayed.PlayerID)
	}

	g.mu.Lock()
	after, _ := json.Marshal(g.Data)
	updatesAfter := g.Updates
	g.mu.Unlock()
	if string(before) != string(after) || updatesAfter != updatesBefore {
		t.Fatalf("ping touched game state:\n before %s\n after  %s", before, after)
	}
}
