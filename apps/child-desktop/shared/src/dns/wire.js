/**
 * Just enough of the DNS message format to read a question and refuse it.
 *
 * The proxy never builds an answer — every allowed lookup is relayed verbatim to
 * the resolver the machine was already using, and the reply comes back
 * untouched. So the only encoding here is a refusal, and the only decoding is
 * "what was asked, and how many bytes did the question take".
 *
 * RFC 1035 §4. A message is a 12-byte header followed by `qdcount` questions:
 * a name as length-prefixed labels terminated by a zero byte, then a 16-bit type
 * and a 16-bit class.
 */

/** Query types worth recording. Everything else is plumbing, not browsing. */
export const TYPE_A = 1;
export const TYPE_AAAA = 28;
export const TYPE_HTTPS = 65;

const MAX_LABELS = 128;

/**
 * Read the first question out of a query.
 *
 * Returns null for anything that is not a well-formed standard query with at
 * least one question — a malformed packet is forwarded blindly rather than
 * answered, because guessing at it is how a resolver starts breaking the network
 * it is supposed to be filtering.
 *
 * @returns {{id: number, name: string, type: number, questionEnd: number}|null}
 */
export function parseQuery(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;

  const flags = buf.readUInt16BE(2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >> 11) & 0x0f;
  if (isResponse || opcode !== 0) return null;

  if (buf.readUInt16BE(4) < 1) return null; // qdcount

  const labels = [];
  let offset = 12;
  for (let i = 0; i < MAX_LABELS; i += 1) {
    if (offset >= buf.length) return null;
    const len = buf[offset];

    // A compression pointer cannot legally appear in the first question — there
    // is nothing before it to point at — so one here means a packet we should
    // not be interpreting.
    if ((len & 0xc0) !== 0) return null;

    offset += 1;
    if (len === 0) break;
    if (offset + len > buf.length) return null;
    labels.push(buf.toString('ascii', offset, offset + len));
    offset += len;
  }

  if (offset + 4 > buf.length) return null;
  const type = buf.readUInt16BE(offset);

  return {
    id: buf.readUInt16BE(0),
    name: labels.join('.').toLowerCase(),
    type,
    questionEnd: offset + 4,
  };
}

/**
 * "That name does not exist", as an answer to this exact query.
 *
 * NXDOMAIN rather than an address that goes nowhere. Handing back `0.0.0.0`
 * leaves the browser opening a connection that hangs until it times out, and the
 * child sees a spinner; NXDOMAIN fails immediately with a name-resolution error,
 * which is both faster and closer to the truth — as far as this machine is
 * concerned the name really has no address.
 *
 * The response is header plus question and nothing else, with all three record
 * counts zeroed. Copying the query and patching flags in place would leave any
 * EDNS OPT record the client attached sitting in a section the counts now say is
 * empty.
 */
export function refuse(buf, question) {
  const response = Buffer.alloc(question.questionEnd);
  buf.copy(response, 0, 0, question.questionEnd);

  const flags = buf.readUInt16BE(2);
  const recursionDesired = flags & 0x0100;
  //  QR=1 response · AA=1 we are authoritative for this refusal ·
  //  RA=1 recursion is available · RCODE=3 NXDOMAIN
  response.writeUInt16BE(0x8480 | recursionDesired | 0x0003, 2);
  response.writeUInt16BE(1, 4); // qdcount
  response.writeUInt16BE(0, 6); // ancount
  response.writeUInt16BE(0, 8); // nscount
  response.writeUInt16BE(0, 10); // arcount

  return response;
}

/** Rewrite a message's transaction id in place, for the proxy's id mapping. */
export function setId(buf, id) {
  buf.writeUInt16BE(id, 0);
  return buf;
}
