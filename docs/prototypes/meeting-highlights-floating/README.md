# Meeting highlights layout prototype

Question: how should meeting highlights float above the minutes without obscuring navigation or taking a permanent side column?

The user selected **top V2, option A**, on 2026-10-30: a horizontal card beneath navigation, full reader width, a one-line collapsed state, no provenance/footer row, and end-only automatic opening. Narrow screens keep a bottom card.

- `v1-options.html`: original right-bottom, bottom-horizontal and centre alternatives.
- `v2-top.html`: top-horizontal A and upper-right B; selected A.

These are standalone throwaway HTML prototypes using a static sample meeting. They do not mutate the backend. Open either file directly, or run `python3 -m http.server 43548 --directory docs/prototypes/meeting-highlights-floating` and visit `/v2-top.html?variant=A`. Arrow controls and keyboard left/right switch variants; collapse/expand/close are interactive.

Keep these prototypes on this branch. Production receives a maintained implementation of the selected option. Desktop/split/phone checks covered geometry, navigation clearance, footer removal and keyboard controls.
