# GameStore Documentation

## Overview

The GameStore provides a sophisticated state management solution for handling deeply nested game state objects. It's built on Svelte's writable store and implements specialized logic for recursive state updates and deletions.

## Core Features

1. **Deep Nested Updates**: Modify any part of the nested state structure without affecting other parts
2. **Null-Based Deletions**: Remove items from any level of the state tree by setting them to `null`
3. **Type Safety**: Leverages TypeScript's type system for catching errors at compile time
4. **Immutable Updates**: All state changes follow immutable update patterns

## State Structure

The GameStore manages a state object based on the `GameDTO` interface with three main sections:

```typescript
interface GameDTO {
  cards: Record<string, Partial<CardDTO>>; // cardId, state
  decks: Record<string, Partial<DeckDTO>>; // deckId, state
  players: Record<string, Partial<PlayerDTO>>; // playerId, state
}
```

This structure maintains:
- Cards on the table (position, rotation, images)
- Decks (collections of cards with position and metadata)
- Players (with trays for held cards, seating, and other player data)

## Key Functions

### updateState

The most important function in the GameStore is `updateState`, which handles recursive updates and deletions:

```typescript
function updateState(update: PartialWithNull<GameDTO>) {
  const paths = findNullPaths(update);

  game.update((state) => {
    let newState = { ...state };

    // 1. Remove nulls
    for (const path of paths) {
      newState = removePathFromObject(newState, path);
    }

    // 2. Remove nulls from update object itself (so merge doesn't re-add them)
    const cleanedUpdate = deepFilterNulls(update);

    // 3. Merge in the remaining values
    return merge(newState, cleanedUpdate);
  });
}
```

This function:
1. Finds all paths to `null` values in the update object
2. Removes those paths from the current state
3. Cleans the update object by removing all nulls
4. Merges the cleaned update into the state

### Helper Functions

#### findNullPaths

Recursively finds all paths to `null` values in an object:

```typescript
function findNullPaths(
  obj: Record<string, any>,
  currentPath: string[] = []
): string[][] {
  const nullPaths: string[][] = [];

  for (const [key, value] of Object.entries(obj)) {
    const newPath = [...currentPath, key];

    if (value === null) {
      nullPaths.push(newPath);
    } else if (typeof value === 'object' && value !== null) {
      nullPaths.push(...findNullPaths(value, newPath));
    }
  }

  return nullPaths;
}
```

#### removePathFromObject

Removes a specific path from an object (used for null-based deletions):

```typescript
function removePathFromObject(obj: any, path: string[]): any {
  if (path.length === 0) return obj;

  const [firstKey, ...restPath] = path;

  if (!(firstKey in obj)) return obj;

  // At the final key: remove it
  if (restPath.length === 0) {
    const { [firstKey]: _, ...rest } = obj;
    return rest;
  }

  // Recurse deeper
  return {
    ...obj,
    [firstKey]: removePathFromObject(obj[firstKey], restPath)
  };
}
```

#### deepFilterNulls

Recursively removes all null values from an object:

```typescript
function deepFilterNulls<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(deepFilterNulls) as unknown as T;
  }

  const result: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) continue;
    result[key] = deepFilterNulls(value);
  }
  return result;
}
```

## Type System

The store uses a specialized recursive type to handle deep partial updates with nulls:

```typescript
type PartialWithNull<T> = {
  [P in keyof T]?: T[P] extends object
    ? PartialWithNull<T[P]> | null
    : T[P] | null;
};
```

This allows any property in the update to be either:
- The original type
- A partial object of that type (for nested objects)
- `null` (for deletions)

## Usage Examples

### Adding Items

```typescript
// Add a card to the table
const cardState = {
  position: [1, 2, 3] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  faceImageUrl: 'test-image.png'
};

gameStore.updateState({ cards: { 'card:name:index': cardState } });
```

### Updating Items

```typescript
// Update a card's position
gameStore.updateState({
  cards: {
    'card:name:index': {
      position: [4, 5, 6] as [number, number, number]
    }
  }
});
```

### Removing Items

```typescript
// Remove a card from the table
gameStore.updateState({
  cards: { 'card:name:index': null }
});
```

### Moving Items Between Collections

This example shows moving a card from the table to a player's tray:

```typescript
// Get the card state
const card = get(gameStore).cards?.['card:name:index'];

// Add to tray and remove from table in one update
gameStore.updateState({
  players: { 'player:me': { tray: { 'card:name:index': card } } },
  cards: { 'card:name:index': null }
});
```

## Complete Example

Here's a more complex example from the tests that demonstrates moving cards between collections while maintaining other state:

```typescript
// Initial state with cards in tray and on table
const trayWithCards = { mock1: mockCard, mock2: mockCard }; // 2 cards in tray
const tableWithCards = { mock3: mockCard, mock4: mockCard }; // 2 cards on table

gameStore.set({
  players: { me: { tray: { ...trayWithCards } } },
  cards: { ...tableWithCards }
});

// Move mock3 from table to tray
gameStore.updateState({
  players: { me: { tray: { mock3: mockCard } } }, // add mock3 to tray
  cards: { mock3: null } // remove mock3 from table
});

// Result:
// - tray now has mock1, mock2, and mock3
// - table now only has mock4
```

## Best Practices

1. **Use Null for Deletions**: To remove an item, set its value to `null` in the update object
2. **Partial Updates**: Only include the properties you want to change
3. **Type Safety**: Use TypeScript to ensure your updates match the expected structure
4. **Immutability**: Treat all objects as immutable for predictable state updates
5. **Single Update**: Try to make related changes in a single updateState call for atomicity
