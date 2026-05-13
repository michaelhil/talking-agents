---
title: Westinghouse PWR EOPs — Index
---

# Westinghouse PWR Emergency Operating Procedures

A complete set of Westinghouse PWR Emergency Operating Procedures (EOPs)
authored in
[Procedure Markdown (procmd) v0.1](https://github.com/michaelhil/talkingAgents/blob/master/docs/procedure-md.md).

> ⚠️ **LLM-reconstructed content — not licensed plant procedures.**
> See [Scope and disclaimers](scope.md) before reading further.

The procedures here are interlinked: branches in one EOP refer directly
to steps in another via `[[wikilinks]]`. Start at [[E-0]] for any
post-trip / post-SI scenario; the diagnostic flow there transitions to
the appropriate event-specific procedure. The Critical Safety Function
status trees (FR-x family) run continuously alongside the main EOP from
event entry through recovery.

## E-series — Initial Diagnostic and Mitigation

| ID | Title |
|---|---|
| [[E-0]] | Reactor Trip or Safety Injection |
| [[E-1]] | Loss of Reactor or Secondary Coolant |
| [[E-2]] | Faulted Steam Generator Isolation |
| [[E-3]] | Steam Generator Tube Rupture |

## ECA-series — Extreme Conditions

| ID | Title |
|---|---|
| [[ECA-0.0]] | Loss of All AC Power |
| [[ECA-1.1]] | Loss of Emergency Coolant Recirculation |
| [[ECA-1.2]] | LOCA Outside Containment |
| [[ECA-2.1]] | Uncontrolled Depressurization of All Steam Generators |
| [[ECA-3.1]] | SGTR with Loss of Reactor Coolant — Subcooled Recovery |
| [[ECA-3.2]] | SGTR with Loss of Reactor Coolant — Saturated Recovery |
| [[ECA-3.3]] | SGTR Without Pressurizer Pressure Control |

## ES-series — Post-Trip Recovery

| ID | Title |
|---|---|
| [[ES-0.0]] | Rediagnosis |
| [[ES-0.1]] | Reactor Trip Response |
| [[ES-0.2]] | Natural Circulation Cooldown |
| [[ES-1.1]] | SI Termination |
| [[ES-1.2]] | Post-LOCA Cooldown and Depressurization |
| [[ES-1.3]] | Transfer to Cold Leg Recirculation |
| [[ES-1.4]] | Transfer to Hot Leg Recirculation |
| [[ES-3.1]] | Post-SGTR Cooldown Using Backfill |
| [[ES-3.2]] | Post-SGTR Cooldown Using Blowdown |
| [[ES-3.3]] | Post-SGTR Cooldown Using Steam Dump |

## FR-series — Critical Safety Function Status Trees

These run as `Concurrent: ... [independent]` from event entry; they monitor
their respective Critical Safety Function and override the active EOP if
the CSF degrades to RED or ORANGE.

### FR-S — Subcriticality
| ID | Title |
|---|---|
| [[FR-S.1]] | Response to Nuclear Power Generation / ATWS |
| [[FR-S.2]] | Response to Loss of Core Shutdown |

### FR-C — Core Cooling
| ID | Title |
|---|---|
| [[FR-C.1]] | Response to Inadequate Core Cooling |
| [[FR-C.2]] | Response to Degraded Core Cooling |
| [[FR-C.3]] | Response to Saturated Core Cooling Conditions |

### FR-H — Heat Sink
| ID | Title |
|---|---|
| [[FR-H.1]] | Response to Loss of Secondary Heat Sink |
| [[FR-H.2]] | Response to Steam Generator Overpressure |
| [[FR-H.3]] | Response to Steam Generator High Level |
| [[FR-H.4]] | Response to Loss of Normal Steam Release Capabilities |
| [[FR-H.5]] | Response to Steam Generator Low Level |

### FR-P — RCS Integrity (Pressurized Thermal Shock)
| ID | Title |
|---|---|
| [[FR-P.1]] | Response to Imminent Pressurized Thermal Shock Condition |
| [[FR-P.2]] | Response to Anticipated Pressurized Thermal Shock Condition |

### FR-Z — Containment
| ID | Title |
|---|---|
| [[FR-Z.1]] | Response to High Containment Pressure |
| [[FR-Z.2]] | Response to Containment Flooding |
| [[FR-Z.3]] | Response to High Containment Radiation |

### FR-I — RCS Inventory
| ID | Title |
|---|---|
| [[FR-I.1]] | Response to High Pressurizer Level |
| [[FR-I.2]] | Response to Low Pressurizer Level |
| [[FR-I.3]] | Response to Voids in Reactor Vessel |

## Profiles

- [[nuclear-erg]] — domain synonyms (`RNO:`, `CSF:`)
