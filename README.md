# Excession Labs Security: Make custom app

A Make (make.com) custom app for the public APIs of Excession Labs, a security lab.

| Module | Type | What it calls |
|---|---|---|
| Check Security Headers | Action | `GET https://penetrationtestservices.com/api/check-headers?url=...` |
| Find Pentest Providers | Search | `GET https://pentestcompare.com/data/providers.json`, filtered inside the module |
| Request a Penetration Test | Action | `POST https://penetrationtestservices.com/api/agent/request` with the agent key |
| Make an API Call | Universal | Any path on `https://penetrationtestservices.com`. Make requires a universal module for a public app |

The connection is an API key. It is an agent key that starts with `exl_agent_`. Only Request a Penetration Test sends it.

## Get an agent key

```
curl -X POST https://penetrationtestservices.com/agent/auth \
  -H 'content-type: application/json' -d '{"agent_name": "Make"}'
```

The answer holds `access_token`. It is shown once. Revoke it with `DELETE https://penetrationtestservices.com/agent/auth` and the same bearer header. Details: https://penetrationtestservices.com/auth.md

## Limits of the service

- Check Security Headers: 12 checks a minute for each IP address. It reads headers only. It is not a penetration test.
- Request a Penetration Test: 5 requests a day for each key and 3 a day for each email address. The person named in the request must have asked for it (`person_consent`) and must own the systems or be allowed to arrange a test (`authorized`). Excession Labs replies to that person by email. Testing starts only after a written scope and written authorization from the system owner. Do not put passwords, keys or tokens in the notes or targets. The service refuses them.
- Find Pentest Providers: the dataset is sorted A to Z, not ranked. "Unknown" in a scope field is not a "yes". The `publisher_owned` field is true for the Excession Labs row.

## Files

```
app/
  metadata.json                  app name, label, description
  base.json                      base URL, error message, log sanitizing
  connection/
    metadata.json                type: apikey
    parameters.json              the agent key field (password type, pattern exl_agent_...)
    api.json                     the Communication tab of the connection
  modules/<name>/
    metadata.json                label, type, description
    communication.json           the Communication tab
    parameters.json              Mappable parameters
    interface.json               Interface (output fields)
    samples.json                 Samples
test/replay.mjs                  replays each module's HTTP calls against the live APIs
listing.md                       text for the app listing
```

Each JSON file is the content of one tab in the Make Apps editor. Paste it as it is. The module `type` in `metadata.json` tells which module type to pick in the editor. The names `excession-labs-security` (app) and `excession-labs-agent-key` (connection) are the internal names.

## Test

```
node test/replay.mjs                 # read-only modules, connection form, universal module
EXL_AGENT_KEY=... node test/replay.mjs --write   # adds Request a Penetration Test, sends 1 test request
```

The script reads `app/*.json`, evaluates the `{{ }}` expressions with a small subset of IML, sends the HTTP calls and checks status, error text, filters, limit and that the output keys match `interface.json`. It does not replace a test in a Make scenario. The `--write` run creates one request from an `@example.com` address, stored as test data.

## Known limit of the connection test

The service has no read-only call that checks an agent key. The connection checks the key format (`^exl_agent_[A-Za-z0-9]{32,}$`) and calls `GET /agent/auth`, which answers 200 for any caller. A wrong key shows up when Request a Penetration Test runs and gets HTTP 401.

## Licence

MIT. The provider dataset from PentestCompare is CC BY 4.0.
