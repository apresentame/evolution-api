import { getAvailableNumbers } from './getAvailableNumbers';

export type WhatsappJidVerification = {
  jid: string;
  exists: boolean;
};

function stripPlus(jid: string) {
  return jid?.startsWith('+') ? jid.slice(1) : jid;
}

/**
 * Correlates the WhatsApp server answer with the jid we queried.
 *
 * The server replies with the canonical jid of the contact, which may differ from the jid we build
 * locally: the Brazilian ninth digit and the Mexican/Argentinian 1/9 prefix are both optional in the
 * registered form. Comparing by strict equality would discard a positive answer whenever the server
 * canonicalizes the number differently, so the match is done against every accepted variant.
 */
export function resolveWhatsappJid(userJid: string, verify: WhatsappJidVerification[]): WhatsappJidVerification {
  const jid = stripPlus(userJid);
  const variants = new Set(getAvailableNumbers(jid));
  variants.add(jid);

  const matches = (verify ?? []).filter((result) => result?.jid && variants.has(stripPlus(result.jid)));

  // The queried form takes precedence, so a number registered in both variants stays stable.
  const exactMatch = matches.find((result) => result.exists && stripPlus(result.jid) === jid);
  const verified = exactMatch ?? matches.find((result) => result.exists);

  if (!verified) {
    return { jid: userJid, exists: false };
  }

  return { jid: verified.jid, exists: true };
}
