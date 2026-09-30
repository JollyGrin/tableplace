import { cardActions } from './card';
import { deckActions } from './deck';
import { playerActions } from './player';
import { trayActions } from './tray';
import { pieceActions } from './piece';
import { snapActions } from './snap';
import { bagActions } from './bag';
import { lockActions } from './lock';
import { rotateActions } from './rotate';
import { coachActions } from './coach';

export const gameActions = {
	...cardActions,
	...deckActions,
	...playerActions,
	...trayActions,
	...pieceActions,
	...snapActions,
	...bagActions,
	...lockActions,
	...rotateActions,
	...coachActions
};
