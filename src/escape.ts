// modified version from node-postgres
// https://github.com/brianc/node-postgres/blob/2a8efbee09a284be12748ed3962bc9b816965e36/packages/pg/lib/utils.js#L175

export function escapeIdentifier(str: string) {
  return `"${str.replace(/"/g, '""')}"`;
}

export function escapeLiteral(str: string) {
  let hasBackslash = false;
  let escaped = "'";

  for (let c of str) {
    if (c === "'") {
      escaped += c + c;
    } else if (c === "\\") {
      escaped += c + c;
      hasBackslash = true;
    } else {
      escaped += c;
    }
  }

  escaped += "'";

  if (hasBackslash === true) {
    escaped = " E" + escaped;
  }

  return escaped;
}
