import { CESIUM_GITHUB_REPO } from "@/lib/releases";
import { DEFAULT_PRODUCTION_SITE_URL } from "@/lib/site-url";

/** Posted version of the hosted Terms of Service. Bump when the text changes. */
export const TERMS_VERSION = "2026-09-01";

export const TERMS_EFFECTIVE_DATE = "1 September 2026";

export const TERMS_PATH = "/terms";

export const LICENSE_PATH = "/license";

export const CESIUM_SOURCE_URL = `https://github.com/${CESIUM_GITHUB_REPO}`;

export const CESIUM_LICENSE_BLOB_URL = `${CESIUM_SOURCE_URL}/blob/main/LICENSE`;

export const CESIUM_LICENSE_RAW_URL = `${CESIUM_SOURCE_URL}/raw/main/LICENSE`;

/** Canonical GNU text of the license that ships in this repository. */
export const AGPL_CANONICAL_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

export const AGPL_SPDX = "AGPL-3.0";

export const AGPL_NAME = "GNU Affero General Public License, version 3";

export const PUBLIC_SITE_HOST = "cesium.techlitnow.com";

export type LegalPagePath = typeof TERMS_PATH | typeof LICENSE_PATH;

export function getHostedLegalUrl(path: LegalPagePath): string {
  return `${DEFAULT_PRODUCTION_SITE_URL}${path}`;
}

/**
 * In-app legal links: path-relative on a real http(s) origin, hosted
 * production URL on file:// (Electron / mobile WebView).
 */
export function getLegalPageUrl(
  path: LegalPagePath,
  location: { protocol: string } | null = typeof window === "undefined"
    ? null
    : { protocol: window.location.protocol }
): string {
  if (location?.protocol === "file:") {
    return getHostedLegalUrl(path);
  }
  return path;
}

export type TermsAcceptanceMetadata = {
  termsAccepted: true;
  legalAccepted: true;
  termsVersion: string;
  termsAcceptedAt: string;
};

export function buildTermsAcceptanceMetadata(
  acceptedAt = new Date().toISOString()
): TermsAcceptanceMetadata {
  return {
    termsAccepted: true,
    legalAccepted: true,
    termsVersion: TERMS_VERSION,
    termsAcceptedAt: acceptedAt,
  };
}

export type TermsSection = {
  id: string;
  title: string;
  paragraphs: string[];
};

/**
 * Hosted Terms of Service. This is a contract for use of the public Cesium
 * instance and related hosted surfaces. It does not replace the AGPL for
 * the software itself.
 */
export const TERMS_SECTIONS: TermsSection[] = [
  {
    id: "agreement",
    title: "Agreement",
    paragraphs: [
      `These Terms of Service (the "Terms") govern your access to and use of Cesium: the workbench, engines, websites, apps, APIs, and related hosted surfaces, including the public instance at ${PUBLIC_SITE_HOST} (together, the "Service").`,
      "By creating an account, checking the agreement box, signing in, continuing as a guest, downloading or installing a client, connecting an engine, or otherwise using the Service, you agree to these Terms. If you do not agree, do not use the Service.",
      "If you use Cesium on behalf of an organization, you represent that you have authority to bind that organization, and \"you\" includes that organization.",
    ],
  },
  {
    id: "who",
    title: "Who we are; which instance you use",
    paragraphs: [
      `The public hosted Service at ${PUBLIC_SITE_HOST} is operated by the maintainers of that instance ("we", "us", "Cesium"). These Terms are the contract for that public instance and for accounts, sync, and related hosted features tied to it.`,
      "If you self-host, fork, or run your own Cesium instance, you are the operator of that instance. The software license still applies. These hosted Terms apply to your instance only if you adopt them; your users' contract is with you, not with the public-instance operators.",
      "A third party may also operate a Cesium instance. That operator's terms, if any, apply to that instance in addition to the software license.",
    ],
  },
  {
    id: "license",
    title: "Software license and your rights",
    paragraphs: [
      `The Cesium software is free software licensed under the ${AGPL_NAME} ("AGPL-3.0"). The license is included with the source, posted at ${LICENSE_PATH} on this site, and published at ${CESIUM_LICENSE_BLOB_URL}. The canonical GNU text is at ${AGPL_CANONICAL_URL}.`,
      "AGPL-3.0 grants you broad rights to run, study, share, and modify the software, including commercial use, subject to its conditions. Those conditions include copyleft: if you convey the software or a modified version, you must do so under AGPL-3.0 and keep license notices intact. For a modified version you let others interact with over a network, AGPL-3.0 section 13 requires you to offer that version's corresponding source.",
      "These Terms do not take away rights the AGPL grants you in the software. They add a contract for the hosted Service, accounts, and our operation of the public instance. If there is a conflict about your right to run, modify, or convey the software you already have, the AGPL controls for those copyright permissions. If there is a conflict about use of our hosted Service, accounts, or infrastructure, these Terms control.",
      `Source code for the public project is at ${CESIUM_SOURCE_URL}. That repository is the corresponding source offer for the public instance, as AGPL-3.0 section 13 requires.`,
      "Cesium, the mark, and related branding are not licensed to you for use as a trademark. Do not imply endorsement or that an unofficial instance is the public Service.",
    ],
  },
  {
    id: "service",
    title: "The hosted Service",
    paragraphs: [
      "The Service may include account registration, device linking, cloud sync, conversation snapshots, engine rendezvous, GitHub pairing, Codespaces device setup, downloads, inference or transcription relays, and other features we choose to offer. Features may be preview, experimental, rate-limited, or withdrawn.",
      "We do not promise uptime, durability, or that any hosted feature will remain available. Local-first use does not require an account. An account does not make us a bailee of your code, secrets, or agent output.",
    ],
  },
  {
    id: "eligibility",
    title: "Eligibility",
    paragraphs: [
      "You must be at least 13 years old, and at least the age of digital consent in your country (16 in much of the EEA unless a lower age is set by local law). If you are under the age of majority where you live, you may use the Service only with a parent or guardian's consent where that is required.",
      "You may not use the Service if you are barred from doing so under the laws of your country, under United States export or sanctions rules, or under these Terms.",
    ],
  },
  {
    id: "accounts",
    title: "Accounts and access",
    paragraphs: [
      "You are responsible for your account, authentication methods, device keys, session tokens, and for every action taken with them. Keep credentials confidential. Notify us if you believe an account or device key is compromised.",
      "Possession of a device key, session token, rendezvous secret, or engine password can be treated as authority to use that context. Anyone you share those with can act as you.",
      "Guest, local-only, and signed-out use is still use of the Service when you hit our websites, APIs, or hosted pairing. These Terms apply to that use.",
      "We may refuse, suspend, or delete an account or hosted data when we reasonably believe these Terms, law, or the safety of the Service require it.",
    ],
  },
  {
    id: "responsibilities",
    title: "Your responsibilities",
    paragraphs: [
      "You use Cesium at your own risk. You are solely responsible for: (a) what you store, sync, send, or expose; (b) every agent, tool, terminal, and file operation you start or allow; (c) compliance with law and third-party terms; (d) backups; and (e) reviewing agent output before you rely on it.",
      "Cesium is a workbench and a set of tools. It is not a lawyer, doctor, financial adviser, or licensed professional, and it does not create a fiduciary relationship.",
    ],
  },
  {
    id: "secrets",
    title: "Secrets, tokens, and credentials",
    paragraphs: [
      "You may store API keys, provider tokens, engine passwords, GitHub tokens, cloud secrets, and similar credentials in settings, environment variables, profiles, engines, or hosted sync. You decide what to store. You are solely responsible for those secrets and for any use or leak that follows.",
      "On-screen masking, redaction, or \"obfuscation\" of tokens is a convenience. It is not encryption, access control, or a promise that a secret is safe from the process, disk, sync replica, screenshot, log, backup, model provider, or another person with access to the device or account.",
      "Secrets you save may be written to local app data, browser storage, engine databases, environment files, or cloud documents you enable. Syncing an account or linking a device can copy those values to other machines and to our processors. Turning on cloud sync is your instruction to transmit that data.",
      "Do not put secrets into prompts, terminals, repositories, or Codespaces unless you accept that agents, providers, and hosts may see them. Revoke and rotate credentials yourself if a device, Codespace, or account is lost.",
      "We are not liable for unauthorized use of credentials you supplied, stored, synced, or pasted into the Service.",
    ],
  },
  {
    id: "agents",
    title: "Agents, tools, and automation",
    paragraphs: [
      "You are the principal for every agent run. Agents may read and write files, run shell commands, call tools, browse, use credentials you configured, and take other actions the selected backend allows. Approving a tool, enabling auto-run, or leaving a session unattended is your authorization.",
      "Agent output can be wrong, incomplete, insecure, or harmful. You must review edits, commands, and tool calls. You are responsible for damage to your systems, data, third-party accounts, and other people caused by agents you run.",
      "Usage, tokens, and bills from model providers, CLIs, and cloud agents are yours. We do not control third-party models and do not warrant their behavior, retention, or training practices.",
      "Do not use agents to violate law, these Terms, or another party's terms; to attack systems you do not own or have explicit authorization to test; or to generate or operate malware, credential theft, or similar abuse.",
    ],
  },
  {
    id: "workspaces",
    title: "Workspaces, files, and terminals",
    paragraphs: [
      "Workspaces point at folders you choose. The engine can read, write, watch, and execute in those trees and in any path you later allow. You must only open folders and grant roots you are allowed to use.",
      "Integrated terminals, file watchers, git operations, and browser-machine virtual filesystems run with the privileges of the engine process. That is equivalent to giving the session a user on that machine.",
    ],
  },
  {
    id: "storage",
    title: "Storage, databases, and persistence",
    paragraphs: [
      "Cesium may persist workspaces, conversations, settings, secrets, and logs using local files, browser storage, SQLite or JSON profiles, Postgres, Redis, Convex, or other stores you or we configure. Persistence is not a backup. We do not warrant that stored data will be complete, uncorrupted, or recoverable.",
      "Hosted databases and sync replicas may retain copies after you delete a local file until those systems expire or compact data. Legal holds or abuse investigations may require longer retention where the law allows.",
      "If you run your own engine database, you are the controller of that store.",
    ],
  },
  {
    id: "sync",
    title: "Synchronization across machines",
    paragraphs: [
      "If you enable cloud sync or sign in, we may store and replicate account-scoped data such as server connection metadata, rendezvous secrets, personalization, onboarding state, and conversation snapshots so another device can restore them.",
      "Sync is optional. Local-only mode keeps that mirror off on that device. Data already synced stays in the cloud until you delete it or we delete the account. Sync is not end-to-end encrypted unless we expressly say a field is.",
      "You are responsible for which devices you link and for unlinking devices you no longer control.",
    ],
  },
  {
    id: "github-codespaces",
    title: "GitHub, Codespaces, and remote compute",
    paragraphs: [
      "GitHub sign-in, device flow, repository access, and Codespaces are provided by GitHub under GitHub's terms and policies. We are not GitHub. A Codespace is a remote machine you asked GitHub to create. Secrets, tokens, and workspace files you inject there are exposed to that environment and to GitHub's operators as their terms describe.",
      "You are responsible for Codespace lifetime, spend, network exposure, and for tearing down environments that still hold credentials. \"Ephemeral\" does not mean forgotten, snapshotted, or logged.",
      "Other remote hosts you attach (SSH, tunnels, VMs, CI runners, cloud GPUs) are likewise your systems or your vendors. We do not secure them for you.",
    ],
  },
  {
    id: "clients",
    title: "Browser-only, desktop, mobile, and local-only use",
    paragraphs: [
      "You may use Cesium in a browser against a remote engine, as a desktop app, as a mobile or Wear client, or in a browser-only \"browser machine\" that keeps a virtual workspace in the tab.",
      "Browser-only use still processes data in memory, in origin storage, and on any engine or API the tab calls. Closing the tab does not delete synced cloud data or provider logs. It is not a private mode with respect to model APIs.",
      "Packaged apps may open hosted account and legal pages on the public site because in-app auth widgets require an allowlisted origin. Using those pages is use of the hosted Service.",
      "Local-only and guest modes reduce what we receive. They do not remove your responsibility for secrets, agents, or third-party APIs you still call.",
    ],
  },
  {
    id: "engines",
    title: "Engines, servers, and pairing",
    paragraphs: [
      "An engine (desktop, `cesium-workbench`, browser machine, or other server) is software you run or that someone runs for you. You are responsible for how it is exposed: bind address, CORS, auth, allowed workspace roots, and tunnels.",
      "Rendezvous, pairing codes, and server URLs let a signed-in browser find your engine. Anyone who can complete pairing can use that engine with your account's client. Treat pairing material as a secret.",
      "The public website is not an engine. Do not point workspaces at the account site and expect it to execute your code.",
    ],
  },
  {
    id: "third-parties",
    title: "Third-party services",
    paragraphs: [
      "The Service uses and lets you use third parties, including Clerk (authentication), Convex (hosted sync database), GitHub, Vercel or other hosts, model and inference providers, speech transcription providers, CLI agent backends, and payment or download CDNs.",
      "Those parties have their own terms and privacy notices. Your use of them is a contract with them. We are not responsible for their outages, training use, retention, or security.",
      "Prompts, attachments, audio, repository context, and tool results you send to a provider leave our control once delivered to that provider.",
    ],
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    paragraphs: [
      "You will not, and will not allow an agent to: break the law; infringe others' rights; spread malware; steal or reuse others' credentials; probe or attack systems without documented authorization; interfere with the Service; scrape the hosted Service in a way that harms it; evade limits or suspensions; or use the Service to design or operate prohibited weapons or other clearly criminal activity.",
      "You will not misrepresent the public instance, impersonate the operators, or use our marks to sell an unofficial build as official.",
      "We may rate-limit, block, or report activity we reasonably believe is abuse.",
    ],
  },
  {
    id: "content",
    title: "Your content",
    paragraphs: [
      "You retain rights in your code, prompts, and files. You grant us a limited, worldwide, royalty-free license to host, copy, transmit, and display that content only as needed to operate the Service you asked for (including sync, pairing, backups we choose to make, and abuse review).",
      "You represent that you have the rights to submit that content and to grant this license. You are responsible for licenses of code you open in a workspace, including copyleft obligations that your own conveyance may trigger.",
      "Feedback you send us may be used to improve Cesium without obligation to you.",
    ],
  },
  {
    id: "privacy",
    title: "Privacy and data",
    paragraphs: [
      "We process account identifiers, authentication data, device and server metadata, settings and snapshots you sync, pairing material, and technical logs needed to run the public instance. Engines you run process whatever you open on them.",
      "Clerk, Convex, GitHub, and other processors listed in these Terms handle data as described in their notices. Model and transcription providers receive the payloads you send them.",
      "You can reduce collection by staying local-only, not signing in, and not enabling sync. Account deletion and data export requests for the public instance can be sent to the contact in these Terms. We will honor rights that apply to you (including GDPR/UK GDPR rights where they apply) within the limits of the law and of what we actually store.",
      "Do not use the Service to process special-category personal data or children's data unless you have a lawful basis and the Service is actually suitable for that — it is not designed as a HIPAA, PCI, or school-records system.",
    ],
  },
  {
    id: "warranty",
    title: "No warranty",
    paragraphs: [
      "THE SERVICE AND THE SOFTWARE ARE PROVIDED \"AS IS\" AND \"AS AVAILABLE\". TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. THIS ALIGNS WITH AGPL-3.0 SECTIONS 15 AND 16 FOR THE PROGRAM.",
      "We do not warrant that agents will be safe or correct, that secrets will stay secret, that sync will not lose or leak data, or that the Service will be uninterrupted or secure.",
    ],
  },
  {
    id: "liability",
    title: "Limitation of liability",
    paragraphs: [
      "TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE AND OUR CONTRIBUTORS, HOSTS, AND SUPPLIERS WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR LOSS OF PROFITS, DATA, GOODWILL, SECRETS, OR BUSINESS, EVEN IF ADVISED OF THE POSSIBILITY.",
      "TO THE MAXIMUM EXTENT PERMITTED BY LAW, OUR TOTAL LIABILITY FOR ALL CLAIMS RELATING TO THE SERVICE IS LIMITED TO THE GREATER OF (A) THE AMOUNTS YOU PAID US FOR THE HOSTED SERVICE IN THE THREE MONTHS BEFORE THE CLAIM, OR (B) TWENTY-FIVE US DOLLARS (US $25). IF YOU PAID NOTHING, THE CAP IS US $25.",
      "These limits do not apply to liability that cannot be limited in your country, including death or personal injury caused by negligence, fraud, or (for EEA/UK consumers) other liability that mandatory law keeps with us. They also do not limit your non-waivable consumer remedies.",
    ],
  },
  {
    id: "indemnity",
    title: "Indemnity",
    paragraphs: [
      "If the law allows, you will indemnify and hold us harmless from claims, damages, and reasonable legal fees arising out of your content, your secrets, your agent runs, your engines or Codespaces, your breach of these Terms, or your violation of law or third-party rights. This does not require a consumer to indemnify us where that is prohibited.",
    ],
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    paragraphs: [
      `We may change these Terms from time to time. The current Terms are always posted at ${TERMS_PATH} with a version date. That posting is notice.`,
      "You are responsible for checking the Terms periodically. We may, but are not required to, show a banner, email you, or ask for a fresh checkbox, except where a law requires a specific notice or fresh consent.",
      "If you continue to use the Service after a new version is posted, you accept the new Terms. If you do not agree, stop using the Service and delete your account.",
      `Material changes will bump the version date at the top of ${TERMS_PATH}. The prior text remains in git history at ${CESIUM_SOURCE_URL}.`,
    ],
  },
  {
    id: "termination",
    title: "Suspension and termination",
    paragraphs: [
      "You may stop using the Service at any time and may delete a hosted account through the account provider or by contacting us.",
      "We may suspend or terminate access to the hosted Service immediately if you breach these Terms, if required by law, or if we discontinue the public instance. Your AGPL rights in copies of the software you already have are not revoked by a hosted-account termination, except as the AGPL itself provides.",
      "Sections that by their nature should survive (including license acknowledgements, your responsibilities, secrets, agents, warranty, liability, indemnity, and governing law) survive termination.",
    ],
  },
  {
    id: "export",
    title: "Export and sanctions",
    paragraphs: [
      "You will not use or export the Service or the software in violation of United States or other applicable export-control or sanctions laws, including use in prohibited jurisdictions or by prohibited parties.",
    ],
  },
  {
    id: "consumer",
    title: "Rights that cannot be waived",
    paragraphs: [
      "If you are a consumer in the EEA, United Kingdom, Switzerland, Australia, or another place that gives you mandatory rights, those rights apply. Nothing in these Terms limits them. In those cases, warranty disclaimers and liability caps apply only to the extent local law allows, and you may have additional remedies for digital content that is not in conformity.",
      "If a court finds a term unenforceable, the rest stays in force. A term that would be unfair or illegal in your country is modified to the minimum extent needed, or dropped, rather than voiding the whole agreement.",
    ],
  },
  {
    id: "law",
    title: "Governing law and disputes",
    paragraphs: [
      "Subject to the consumer section above, these Terms are governed by the laws of the United States and the State of California, without regard to conflict-of-law rules, except that the AGPL is interpreted under the rules that apply to that license.",
      "You and we will first try to resolve a dispute informally. If you have a consumer right to sue in your country of residence or to use a statutory small-claims or consumer forum, you keep that right.",
      "Subject to those rights, exclusive venue for disputes about the public hosted Service is the state or federal courts located in California, USA, and you consent to that venue. We do not require consumers to arbitrate or to waive class actions where that requirement is unlawful.",
      "Either party may still seek injunctive relief in any court of competent jurisdiction for misuse of accounts, abuse of the Service, or intellectual-property harm.",
    ],
  },
  {
    id: "misc",
    title: "Miscellaneous",
    paragraphs: [
      "These Terms, plus the AGPL for the software and any additional terms for a specific feature we present to you, are the entire agreement for the hosted Service. They supersede prior terms for that Service.",
      "You may not assign these Terms without our consent, except to a successor of all or substantially all of your assets. We may assign them to a successor operator of the public instance.",
      "A failure to enforce a term is not a waiver. Headings are for convenience only. \"Including\" means \"including without limitation.\"",
      "These Terms are in English. A translation is for convenience. The English text controls except where local law requires otherwise.",
    ],
  },
  {
    id: "contact",
    title: "Contact and source",
    paragraphs: [
      `Questions about these Terms, account deletion, or data requests for the public instance: open an issue or discussion on ${CESIUM_SOURCE_URL}, which is also the official source-code location.`,
      `Software license: ${AGPL_NAME} — ${LICENSE_PATH} on this site, ${CESIUM_LICENSE_BLOB_URL} in the repository, and ${AGPL_CANONICAL_URL} at the GNU Project.`,
    ],
  },
];

export function getTermsSectionIds(): string[] {
  return TERMS_SECTIONS.map((section) => section.id);
}

export function getTermsPlainText(): string {
  return TERMS_SECTIONS.map((section) => {
    return `${section.title}\n${section.paragraphs.join("\n")}`;
  }).join("\n\n");
}
