# AMS CRM dark contract canary

This deployment exposes only the authenticated, read-only
`noli.ams-crm.contract-descriptor.v1` descriptor pinned in
`contract-source-pin.v1.json`.

It has no database client, provider client, command intake, CRM mutation,
eligibility lease, event publisher, or product dispatch authority. Every
rollout field is hard-disabled even if a similarly named environment variable
is accidentally present. The full CRM runtime remains the authority for later
dark command and migration canaries.

Run the credential-free floor with Node 24:

```sh
npm test
```
