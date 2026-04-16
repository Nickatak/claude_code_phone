

## Mobile share links

Reddit mobile share links (`/r/subreddit/s/...`, `reddit.app.link/...`) are opaque
redirect URLs, not direct post links. Resolve them before fetching:

```bash
curl -Ls -o /dev/null -w '%{url_effective}' 'SHARE_URL'
```

This follows the redirect chain and returns the canonical Reddit URL. Then fetch
the resolved URL through passthrough as usual.
