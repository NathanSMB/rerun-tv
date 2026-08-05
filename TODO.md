What to do next:

1) Make it so all the buttons in the players have physical buttons
2) ~~FFMPEG management~~
    - ~~Downloads appropriate FFMPEG on first launch.~~
    - ~~Settings page should include a button to update it.~~
    - ~~The app should be wired up to use the binary it is managing.~~
    - Left to verify on real hardware: the Windows unpack (bsdtar reading the
      zip) and both macOS builds (they are bare binaries, so nothing unpacks —
      the open question is whether an unsigned downloaded executable runs).
      A failure is visible and safe: the encode test rejects it before anything
      is activated, and the gate offers the manual-install link.
3) ~~Create builds for Windows and MacOS.~~
4) Redesign landing page with screenshots included.
