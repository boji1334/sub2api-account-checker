# Security

This userscript runs only on pages matching `*/admin/accounts*`.

It uses the current page origin as the API base and sends requests back to the
same Sub2API admin server. It does not upload account data, Authorization
headers, or test results to this GitHub repository or to a third-party service.

Please install it only from the official repository:

https://github.com/boji1334/sub2api-account-checker

If you find a security issue, please open a GitHub issue with enough detail to
reproduce it. Do not include real tokens, account cookies, or private account
data in public issue text.
