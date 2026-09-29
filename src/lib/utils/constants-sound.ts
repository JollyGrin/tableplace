/** Table sounds (tableplace-204): loudness, rate limits and what counts as a lift. */

/** master loudness of the whole table, 0–1 */
export const SOUND_MASTER_GAIN = 0.5;
/** what you did yourself plays at full loudness… */
export const SOUND_OWN_VOLUME = 1;
/** …what a remote player did plays at this fraction of it */
export const SOUND_REMOTE_VOLUME = 0.3;

/** the same sound never starts twice within this many ms (a burst is one sound) */
export const SOUND_MIN_GAP_MS = 60;
/** no more than this many sounds may be sounding at once */
export const SOUND_MAX_VOICES = 6;

/** a height change of at least this much is a lift (up) or a drop (down) */
export const SOUND_LIFT_DELTA = 0.5;
/** a planar move at least this long, with nothing lifted, is a slide */
export const SOUND_SLIDE_DISTANCE = 1;
/** a patch touching more entities than this is a sync or a scenario load, not a gesture */
export const SOUND_MAX_ENTITIES = 8;
