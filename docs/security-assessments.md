# Security assessments of Awnitboss

Awnitboss is a production real estate CRM that emails and texts consumers on agents' behalf. Between April and November 2026 it went through nine security and compliance assessments, run by AI agents under the direction of Zachary Oliver, using the way of working in this repo.

This page shows how that work is done. It deliberately leaves out anything that would help an attacker: no open findings, no counts of open findings, no locations, no configuration, and no technical detail of any issue. Those are tracked privately and shared only under agreement.

## Who does what

- **Zachary Oliver** sets each assessment's scope, reviews the evidence, decides severity, and accepts or rejects every fix.
- **AI agents** (Claude Code and Codex) do the reading, testing and fixing, in parallel lanes, inside the guards in this repo.
- **Not independent.** None of these assessments was done by an outside firm. There is no SOC 2 report, no third-party penetration test and no ISO certificate. The SOC 2 mapping below is a self-assessment, not an audit opinion.

## The assessments

| When | What | How |
| --- | --- | --- |
| April 2026 | Security audit, authentication, API and secrets | Source-code review against a written severity scale |
| June 2026 | Seven focused audits | One area each, from sign-in and admin access to privacy |
| July 2026 | Full security audit | Source review and a dependency scan |
| August 2026 | Deep audit | Parallel agent lanes by area, a static scan and a dependency audit |
| September 2026 | Legal and compliance audit | Messaging, privacy and fair-housing rules, and the MLS data contract, against the product as built |
| October 2026 | Source-assisted penetration test | Local only, synthetic identities: source review and adversarial tests |
| November 2026 | Sign-in review | Synthetic identities only |
| November 2026 | White-box review and recheck | One agent leading 16 delegated agents, then a recheck of every critical and high finding to date against current code |
| November 2026 | Defensive assessment | Including the AI reply system; local copy and synthetic data only, production not touched |

## How a finding is handled

1. **Recorded with a severity** from a written scale: Critical (exploitable now, high blast radius), High (exploitable now, moderate blast radius, or latent risk on a critical path), Medium (needs a second misconfiguration, or defence in depth), Low (hygiene and documentation).
2. **Proven before it is fixed.** Where possible, a test is written that fails while the issue exists. The guards here enforce the same rule for code: a test only counts if it fails on a deliberately broken copy (see [PROOF.md](../PROOF.md)).
3. **Fixed in a reviewed pull request.** Every change that touches sign-in, billing, data access or a sending path gets one independent review before it merges, and that review is recorded.
4. **Retested on the main branch** after the merge, then rechecked in a later assessment.
5. **Re-verified when the code moves on.** Findings are restated against a specific commit, because a fix that lands and is later reverted is not a fix.

## Results it is safe to publish

- **AI reply system.** 86 adversarial test messages were sent to the system that answers leads by itself. In that testing, no case exposed another lead's data or ignored an opt-out.
- **Sign-in.** In the testing performed, neither the October penetration test nor the November sign-in review found a way past the initial sign-in.

## SOC 2 mapping

Each recorded control is mapped to the SOC 2 Trust Services Criteria (access control, system operations and incident response, change management, risk and vendor management) and marked Implemented, Partial or Gap from the evidence, with a pull request or record for every claim. The full mapping is in the private report. This is a self-assessment, not SOC 2 certification.

## Compliance areas covered

Awnitboss contacts consumers, so its assessments cover more than code security: the Telephone Consumer Protection Act, CAN-SPAM, the California Consumer Privacy Act, fair housing rules, carrier registration for business texting (A2P 10DLC), and the MLS listing-data contract.

## Reporting a problem

To report a security issue in this repo, see [SECURITY.md](../SECURITY.md). For Awnitboss, use the same private report on this repository and say it concerns Awnitboss. Please do not open a public issue.
