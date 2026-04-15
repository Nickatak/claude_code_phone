# Contributing Standards

## Philosophy

Pythonic sensibility in a TypeScript codebase. This code should be scannable,
boring, and obvious. If you have to re-read a line to understand it, rewrite it.

### Core principles

1. **Explicit over implicit** - no clever type inference tricks, no overloaded
   generics doing five things, no magic. If a type isn't obvious, annotate it.
2. **Readability over cleverness** - if a for loop is clearer than a chain of
   `.reduce().flatMap().filter()`, use the for loop.
3. **Name things for what they are** - no abbreviations, no single-letter variables
   outside of trivial loops. `conversationId`, not `convId`. `message`, not `msg`.
4. **Straightforward control flow** - minimize nesting, early-return over else
   chains, avoid callback hell. If async flow gets tangled, break it into named
   functions.

## Error handling

Explicit try/catch at every boundary where an error can occur. Uncaught exceptions
crashing the process is not acceptable. If middleware or a framework catches errors
at a higher level, that's fine - but don't rely on it silently. Be deliberate about
what throws and what's caught.

## Documentation

Every module gets a top-level docstring explaining **why it exists** and what role
it plays in the system. Not what it exports - why it's here.

Every helper/function gets a docstring focused on **why**, not what. The function
name and signature should explain what. The docstring explains why this exists,
why it works this way, or what non-obvious thing it handles.

```typescript
/**
 * Tracks active SDK child processes so the stop endpoint can find and
 * kill them by conversation ID. Without this, we'd have to scan /proc
 * or maintain a PID file.
 */
function registerProcess(conversationId: string, proc: ChildProcess): void {
```

Inline comments only when a specific line is non-obvious - but if you need a lot
of inline comments, the code is probably too clever. Simplify first, comment second.

## Dependencies

Minimal. Every dependency must be justified - what does it give us that we can't
do in a reasonable amount of code ourselves? "It's popular" is not justification.
"It handles edge cases we'd get wrong" is.

## File organization

No rigid rules. If the architecture is right, files stay small naturally. If a
file is getting long, that's a design signal, not a formatting problem.

## Testing

Deferred until the app is stable. This is a small single-user app - we'll reach
a working build first, then add tests.

## Style

- Explicit type annotations where they aid readability (function signatures,
  non-obvious returns). Don't annotate what TypeScript can trivially infer
  (`const x: number = 5` is noise).
- `const` by default, `let` only when mutation is needed.
- No `any` unless absolutely unavoidable, and if so, comment why.
- Prefer `interface` over `type` for object shapes (consistency, not dogma).
- No default exports - named exports only.
