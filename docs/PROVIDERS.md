# Provider Extension Guide

This project now uses a registry-style provider router (`src/providers/router.ts`) so new model vendors can be added without changing HTTP routes.

## Current Providers
- Qwen OAuth (`src/providers/qwen/*`)

## Extension Points
- `src/providers/types.ts`
  - `ChatProvider`
  - `SearchProvider`
- `src/providers/router.ts`
  - `registerChatProvider()`
  - `registerSearchProvider()`

## How to Add Gemini
1. Implement a Gemini provider module, for example:
   - `src/providers/gemini/provider.ts`
2. Make it satisfy `ChatProvider`:
   - `name`
   - `matchesModel(model)`
   - `handleChatCompletion(c, payload)`
3. Register it in `createApp()`:
   - `providerRouter.registerChatProvider(geminiProvider)`
4. Add model mapping in env/config:
   - `MODEL_MAPPINGS` can map external model names to Gemini model ids.
5. Add provider-level quota policy if Gemini has different limits.

## Routing Rule
- Request model -> `ProviderRouter.routeChat(model)` -> first matched provider handles request.
- Keep model matching deterministic and non-overlapping where possible.

## Production Advice
- Keep provider auth/token logic self-contained under its own directory.
- Normalize provider error codes to gateway-level errors before returning to clients.
- For paid providers, keep budget enforcement at gateway level (`quota.ts`) plus provider-specific hard stops.

