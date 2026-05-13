---
type: procedure
procedure-md: 0.6
procedure-id: FR-S.1
title: Response to Nuclear Power Generation / ATWS
profile: nuclear-erg
applies-to: Westinghouse 4-loop PWR
---

# FR-S.1 — Response to Nuclear Power Generation / ATWS

CSF subcriticality RED path: reactor not tripped despite trip signal, or
power generation continuing after trip. Restores subcriticality by
manual trip and emergency boration.

## Step 1 [id: verify-power-generation]
Check: neutron flux > shutdown level OR rod position not bottomed
- Confirmed → #manual-trip
- False alarm, subcritical → [[E-0]]

## Step 2 [id: manual-trip]
Action: manual reactor trip; if no response, open trip breakers locally
- Tripped → #verify-shutdown
- Still not tripped → #emergency-boration

## Step 3 [id: emergency-boration]
Action: initiate emergency boration via charging or boric acid pumps
Within: as fast as available pumps allow
- Subcriticality achieved → #verify-shutdown
- Subcriticality not achievable → [[FR-S.2]]

## Step 4 [id: verify-shutdown]
Check: neutron flux at shutdown level AND adequate shutdown margin
- Confirmed → [[E-0]]
- Not confirmed → #emergency-boration
