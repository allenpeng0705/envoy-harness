/**
 * mDNS / DNS-SD peer discovery (RFC 6762 / 6763).
 *
 * Zero new runtime dependencies: a hand-rolled DNS codec, an injectable
 * UDP socket, a browser, and an advertiser. See `dns-codec.ts` for why.
 */

export {
  DNS_CLASS_IN,
  DNS_TYPE,
  MDNS_ADDRESS,
  MDNS_PORT,
  allRecords,
  decodeMessage,
  encodeName,
  encodeQuery,
  encodeResponse,
  encodeTxtValues,
  type DnsMessage,
  type DnsQuestion,
  type DnsRData,
  type DnsRecord,
  type EncodeRecordInput,
} from "./dns-codec.js";

export {
  ENVOY_PEER_SERVICE_TYPE,
  TXT_KEY_CAPABILITIES,
  TXT_KEY_ID,
  TXT_KEY_MODEL,
  TXT_KEY_VERSION,
  encodeServiceTxt,
  extractServiceRecords,
  instanceNamesFromPtr,
  parseServiceTxt,
  serviceInstanceName,
  serviceRecordsFromMessage,
  srvRData,
  type MdnsServiceInfo,
  type MdnsServiceRecord,
} from "./service.js";

export {
  MDNS_DEFAULT_ADDRESS,
  MDNS_DEFAULT_PORT,
  createDgramMdnsSocket,
  type MdnsSenderInfo,
  type MdnsSocket,
  type MdnsSocketFactory,
} from "./socket.js";

export {
  MdnsBrowser,
  defaultMdnsScheduler,
  type MdnsBrowserOptions,
  type MdnsPeerAnnouncement,
  type MdnsPeerListener,
  type MdnsScheduler,
} from "./browser.js";

export {
  MdnsAdvertiser,
  localHostName,
  resolveAdvertiseAddress,
  type MdnsAdvertiserOptions,
} from "./advertiser.js";
