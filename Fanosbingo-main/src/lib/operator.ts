const OPERATOR_PATH = /^\/o\/([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)(?:\/|$)/;

/**
 * The operator this Mini App was opened for. Each operator's bot points its
 * Mini App at `<app>/o/<slug>`; the bare app URL is the default operator.
 * The backend verifies Telegram's signature against that operator's bot, so
 * this value only selects — it can't grant access to another operator.
 */
export function currentOperatorSlug(): string | undefined {
  return OPERATOR_PATH.exec(window.location.pathname)?.[1];
}
