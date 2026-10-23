How the README images are made (all from the real product; nothing is mocked up except the chat illustration,
which is a screenshot of the drive.trina.app/b hero demo and is labelled as such).

Needs: Bun, ffmpeg, Python 3 with Pillow, and playwright-core (`npm i -g playwright-core` or in a scratch folder)
plus a Chromium binary in $CHROME. S is any scratch directory; R is the repository.

  1. Sample company:   docs/assets/src/seed.sh $S/data > $S/d4.env      (prints MINA=, SAM=, SETUP= tokens)
     Server:           bun run src/cli.ts --data $S/data serve --port 8793
  2. demo.gif:         bun docs/assets/src/demo-steps.ts $S/data http://127.0.0.1:8793 $MINA $SAM $S/demo.json
                       HTML=$R/docs/assets/src/terminal.html DATA=$S/demo.json OUT=$S/frames FPS=12 node capture.mjs
                       ffmpeg -framerate 12 -i $S/frames/f%04d.png -vf palettegen=max_colors=128 pal.png
                       ffmpeg -framerate 12 -i $S/frames/f%04d.png -i pal.png -lavfi paletteuse=dither=none:diff_mode=rectangle demo.gif
  3. screenshots/:     S=$S R=$R node screenshots.mjs   (signs up through the setup token, invites mina and sam, lets
                       Sam's agent ask for a widening promote, then screenshots; rounded corners and shadow added with
                       Pillow at 1400 px wide)
  4. chat-demo.png:    S=$S node chat-shot.mjs, then render.mjs (?v=chat)
     banner.png (1280×400 @2x) and social-preview.png (1280×640): R=$R S=$S node render.mjs (banner.html)
