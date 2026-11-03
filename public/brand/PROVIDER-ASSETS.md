# Provider logo assets

These local image assets are used only to identify upstream providers in the FreeRouter control plane. Provider names remain visible beside the marks; the logos do not imply endorsement or a partnership.

- `google-ai-studio.png` — Google AI Studio's current 96 px product mark, copied from the Google-hosted product icon URL currently linked by the live [AI Studio site](https://aistudio.google.com/): <https://www.gstatic.com/images/branding/productlogos/ai_studio/v1/web-96dp/logo_ai_studio_color_1x_web_96dp.png>. The downloaded asset was byte-compared against that live URL on 2026-11-03.
- `nvidia.svg` — Full NVIDIA horizontal lockup from NVIDIA's official BioNeMo repository: <https://github.com/NVIDIA/bionemo-framework/blob/main/docs/docs/assets/images/logo-white.svg>. Its white-and-green colors are legible on FreeRouter's dark dashboard. Keep the eye and NVIDIA wordmark together and preserve the source proportions, following [NVIDIA's logo guidance](https://www.nvidia.com/en-gb/about-nvidia/legal-info/logo-brand-usage/).
- `openrouter.svg` — OpenRouter's official Volt glyph from the [OpenRouter brand-assets page](https://openrouter.ai/brand), using the dark-surface glyph variant at <https://openrouter.ai/brand/logos/transparent/glyph/svg/glyph-volt.svg>. The local SVG was compared byte-for-byte with the official download on 2026-11-03. OpenRouter's brand page says not to stretch, recolor, or remix the supplied marks.

FreeRouter's own mark in `freerouter-mark.svg` and `src/app/icon.svg` is original and depicts multiple routes converging through a gateway. These files are intentionally identical so the dashboard/login brand and browser favicon stay consistent. Next.js discovers `src/app/icon.svg` through its App Router metadata file convention.
