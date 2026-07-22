# Windows Signing Handoff — Azure Trusted Signing

Status: **CI is fully wired** (`.github/workflows/mac-build.yml`, commits `cdbd8d7` + `5c5760e`).
Both Windows build steps sign automatically once the six repo secrets below exist.
Until then, builds fall back to unsigned installers (current state — SmartScreen warns once).

## What's needed from Azure

| GitHub secret | Where to find it in the Azure Portal |
|---|---|
| `AZURE_SIGN_ENDPOINT` | Trusted Signing account → Overview → Account URI (looks like `https://<region>.codesigning.azure.net`) |
| `AZURE_SIGN_ACCOUNT` | The Trusted Signing account's name |
| `AZURE_SIGN_PROFILE` | Trusted Signing account → Certificate profiles → profile name (Public Trust) |
| `AZURE_TENANT_ID` | Microsoft Entra ID → App registrations → your signing app → Tenant ID |
| `AZURE_CLIENT_ID` | Same app → Application (client) ID |
| `AZURE_CLIENT_SECRET` | Same app → Certificates & secrets → **new client secret** (old values can't be re-viewed — create a fresh one and copy it immediately) |

Also required, one time: on the Trusted Signing account → Access control (IAM) →
the app registration must have the **Trusted Signing Certificate Profile Signer** role.

## Where the secrets go

Repo → Settings → Secrets and variables → Actions:
<https://github.com/bensblueprints/orgtree-mvp/settings/secrets/actions>

Add all six as **repository secrets**. Do not put the values in chat, issues, or docs.

## Trigger a signed build

Once the secrets are in place, re-push the release tag (or cut the next release):

```bash
cd ~/orgtree-mvp
git fetch origin main
git tag -f v1.8.0 origin/main
git push -f origin v1.8.0
```

The `Mac Build` workflow runs; the `build-windows` job will now sign both
`WholeTeam Setup X.Y.Z.exe` and `WholeTeam Member Setup X.Y.Z.exe` via
`electron-builder`'s `azureSignOptions` (schema-verified against the pinned
electron-builder 25.1.8: `endpoint`, `codeSigningAccountName`,
`certificateProfileName`; auth via `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` /
`AZURE_CLIENT_SECRET` env).

## Verify it worked

- Actions tab → the tag's run → `build-windows` job log should show
  `signing with signtool.exe` + Azure Trusted Signing (not "no signing info
  identified, signing is skipped").
- Release assets re-publish: <https://github.com/bensblueprints/orgtree-mvp/releases>
- On a Windows machine: right-click the `.exe` → Properties → Digital
  Signatures tab shows the org name. SmartScreen stops warning once
  reputation accrues (faster with Trusted Signing than a plain OV cert).

## If the Azure account does NOT exist yet

1. Create an Azure subscription (free tier works; Trusted Signing ≈ $10/mo).
2. Portal → Trusted Signing Accounts → Create (pick a region).
3. Identity validation → organization validation (business registration
   details for Advanced Marketing Limited). Microsoft review: ~3–7 business days.
4. Certificate profiles → Create → **Public Trust**.
5. Microsoft Entra ID → App registrations → New registration → copy Tenant ID
   + Client ID → create a client secret.
6. IAM on the Trusted Signing account → assign **Trusted Signing Certificate
   Profile Signer** to that app.
7. Add the six secrets (above), then trigger a signed build (above).
