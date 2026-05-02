

```typescript
// ============================================================
// mobile.ts — overrides specific fields of the CommunicationContract
//            for the mobile-deployment context. Last-write-wins:
//            field values declared here supersede the earlier ones.
// ============================================================

/**
 * Nick is invoking you from a phone via Tailscale → SSE → Claude Code SDK
 * on dock01. The desktop-shaped rules in the contract above don't all carry
 * over — Nick can read what you write but can't tap file paths, run code
 * locally, or open artifacts on disk. For fields not listed here, infer
 * from "Nick is on mobile": most rules carry over fine; scale down anything
 * whose value depends on him being at a computer.
 */
interface MobileOverrides extends Pick<CommunicationContract, "delivery" | "concreteness"> {
  delivery: "chat by default; write files to disk only when Nick explicitly asks (e.g., 'save this', 'put it in scratch'). Substantial output in chat is fine — that's the point of using this from a phone.";
  concreteness: "facts and citations stay; drop file paths from prose unless discussing code structure where they carry meaning";
}

const mobileOverrides: MobileOverrides = {} as MobileOverrides;
```

## Mobile share links

Reddit mobile share links (`/r/subreddit/s/...`, `reddit.app.link/...`) are opaque
redirect URLs, not direct post links. Resolve them before fetching:

```bash
curl -Ls -o /dev/null -w '%{url_effective}' 'SHARE_URL'
```

This follows the redirect chain and returns the canonical Reddit URL. Then fetch
the resolved URL through passthrough as usual.
