/** Runtime configuration, read from /config.json next to the files. Nothing in it is secret. */
export interface AppConfig {
  /** Address of the Keycloak realm (the issuer of the tokens), for example https://chance.example/realms/chance. */
  issuer: string;
  /** Public OIDC client of the app (authorization code with PKCE). */
  clientId: string;
  /** Prefix of every API call. Empty means the same origin (the gateway), which is the normal case. */
  apiBase: string;
  /** Page the payment provider sends the buyer to after paying. Must match payments' DEPOSIT_SUCCESS_URL. */
  depositSuccessPath: string;
  /** Page the payment provider sends the buyer to after declining. Must match payments' DEPOSIT_CANCEL_URL. */
  depositCancelPath: string;
  /**
   * Address of the audit-export function (for example https://chance-audit-export.example/api/audit-export), without
   * a query. Optional: the audit page shows its Export control only when this is set. Its origin is added to the
   * connect-src rule of the Content-Security-Policy when the container starts.
   */
  auditExportUrl?: string;
}
