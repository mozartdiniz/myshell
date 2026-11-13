# Claude Agent applet sprites

Each file is a horizontal strip of 96×96 frames, played at 60 ms per
frame by `js/ui/dock/docklets/agent.js`.

They are cut from the Noto Emoji Animation set by Google, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
(https://googlefonts.github.io/noto-emoji-animation/), keeping every
other frame and scaled down from 512 px:

| File          | Emoji                          |
|---------------|--------------------------------|
| `dead.png`    | 💀 skull (U+1F480)              |
| `idle.png`    | 😴 sleeping face (U+1F634)      |
| `cooking.png` | ⚙️ gear (U+2699 U+FE0F)          |
| `input.png`   | ✋ raised hand (U+270B)          |
| `done.png`    | 🎉 party popper (U+1F389)       |
| `error.png`   | 😵‍💫 face with spiral eyes (U+1F635 U+200D U+1F4AB) |

To rebuild one from the animated WebP
(`https://fonts.gstatic.com/s/e/notoemoji/latest/<codepoint>/512.webp`):

```sh
n=$(magick identify -format "%n\n" in.webp | head -1)
magick in.webp -coalesce -delete "$(seq -s, 1 2 $((n - 1)))" \
    -resize 96x96 -background none +append -strip out.png
```
