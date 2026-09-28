# The allow-list is checked in the proxy and again in every page and handler

Next.js recommends that the proxy only makes optimistic, cookie-only checks. We deliberately query
the `app_users` allow-list in the proxy on every non-public request anyway, so that any page or API
route added later is protected by default and a removed manager loses access on their very next
request (a Supabase session alone would stay valid until it expires). The extra indexed lookup is
negligible for an app with a handful of users. Pages, Server Actions and route handlers still call
`requireUser()` / `requireRole()` / `withUser()` / `withRole()`, because proxy coverage can be lost
by a matcher change and because they need the user's role.
