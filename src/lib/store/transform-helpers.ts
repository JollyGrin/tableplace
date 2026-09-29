/**
 * Takes two objects and returns a new object with the values of the second merged into the first
 * */
export function merge(a: any, b: any): any {
	if (Array.isArray(a) || Array.isArray(b)) {
		return b;
	}
	if (typeof a !== 'object' || typeof b !== 'object') {
		return b;
	}

	const merged: Record<string, any> = {};
	Object.keys(a).forEach((key) => {
		merged[key] = a[key];
	});

	Object.keys(b).forEach((key) => {
		const old = a[key];
		if (old) {
			merged[key] = merge(old, b[key]);
		} else {
			merged[key] = b[key];
		}
	});

	return merged;
}

/**
 * @tech-debt
 *
 * update functions send: id, payload
 * the server refactor accepts: {[id]: payload}
 * example: { cardId: { position: [0,0,0]}}
 *
 * This function takes the payload and transforms it to the new format
 * */
export function transformPayload(
	id: string | Record<string, any>,
	payload?: Record<string, any> | null
): Record<string, any | null> {
	// if id is a string, reform the payload to be {id: payload}
	if (typeof id === 'string')
		return {
			[id]: payload
		};

	return id;
}

/**
 * @tech-debt
 *
 * updates the local state
 * takes a record and store update function
 * if null, will remove it locally (server needs null to remove)
 * merges existing state with new payload
 * */
export function localStateUpdater<T>(
	payload: Record<string, T | null>,
	updater: (fn: (state: Record<string, T>) => Record<string, T>) => void
) {
	const isNull = Object.values(payload).every(
		(value) => value === undefined || value === null
	);

	if (isNull) {
		// on silent update, receives a payload of {cardId: null}
		const id = Object.keys(payload)[0];
		return updater((state) => {
			const { [id]: _, ...rest } = state;
			return rest;
		});
	}

	return updater((state) => {
		return merge(state, payload) as Record<string, any>;
	});
}
