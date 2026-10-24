# GitHub API requests

The shared GitHub client limits each request attempt to 30 seconds, including reading the response body. An expired attempt aborts its fetch. The caller can also cancel a request, including during the wait before a retry.

Read requests have at most three attempts. The delays before the second and third attempts are 250 milliseconds and one second. Retries apply to timeouts, network failures, and HTTP 502, 503, and 504 responses. Other API errors propagate to the operation unchanged.

Only REST GET and HEAD requests and recognizable GraphQL queries are retried. GraphQL documents containing a mutation are never retried. Queries that the client cannot classify conservatively get one attempt.

Writes get one attempt. This includes creating reviews, merging pull requests, creating commits, and posting comments. If GitHub accepts a write but loses its response, retrying it could duplicate the effect. Operation-specific recovery must read the current state before deciding whether to write again.

These limits apply to the actions and the e2e runner, which use the same client. They do not change the behavior of external actions or the `gh` CLI.
