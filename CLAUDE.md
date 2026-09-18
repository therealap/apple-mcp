# apple-mcp Development Guidelines

## Commands
- `bun run dev` - Start the development server
- No specific test or lint commands defined in package.json

## Code Style

### TypeScript Configuration
- Target: ESNext
- Module: ESNext
- Strict mode enabled
- Bundler module resolution

### Formatting & Structure
- Use 2-space indentation (based on existing code)
- Keep lines under 100 characters
- Use explicit type annotations for function parameters and returns

### Naming Conventions
- PascalCase for types, interfaces and Tool constants (e.g., `CONTACTS_TOOL`)
- camelCase for variables and functions
- Use descriptive names that reflect purpose

### Imports
- Use ESM import syntax with `.js` extensions
- Organize imports: external packages first, then internal modules

### Error Handling
- Use try/catch blocks around applescript execution and external operations
- Return both success status and detailed error messages
- Check for required parameters before operations

### Type Safety
- Define strong types for all function parameters 
- Use type guard functions for validating incoming arguments
- Provide detailed TypeScript interfaces for complex objects

### MCP Tool Structure
- Follow established pattern for creating tool definitions
- Include detailed descriptions and proper input schema
- Organize related functionality into separate utility modules
## Committing work — do this without being asked

Before you finish, commit and push whatever you changed. Don't wait to be asked: ap
often closes the tab, and uncommitted work is then only on this disk — no history, no
copy on gibson.

    git add -A && git commit -m "<what changed and why>" && git push

- Write a real message: what changed and why, not "updates".
- **Never commit a secret.** If `git status` shows a token, key, `.env`, or a `.bak`
  of one, stop and tell ap rather than committing it.
- If you deliberately leave something uncommitted (half-done refactor, an experiment),
  say so in your closing message so ap knows it's there.

A nightly sweep on gibson ("Backup - git sweep", 02:40) catches whatever gets missed,
but it commits under a generic `auto-commit:` message and refuses any repo where
anything looks like a secret. Your commit is the one with a useful message — make it.
