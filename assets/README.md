# Brand assets

The ccprovider logo and banner. The SVGs are the source of truth; the PNGs are rendered from
the same artwork.

## The mark

A lowercase `c` whose opening lets a prompt chevron out: the command goes straight to the
provider, with nothing in between. The chevron is the only coloured part.

## Files

| File | Use |
|---|---|
| `logo/ccprovider-symbol.svg`, `-dark.svg` | The mark alone, for light and dark backgrounds |
| `logo/ccprovider-logo.svg`, `-dark.svg` | Horizontal lockup, mark and wordmark |
| `logo/ccprovider-logo-stacked.svg`, `-dark.svg` | Stacked lockup, for square and narrow spaces |
| `logo/ccprovider-app-icon.svg`, `-512.png` | Rounded tile for avatars and app icons. The 512 px PNG is the one to upload as the GitHub avatar |
| `logo/mono/` | One-colour black and white, for print and single-colour uses |
| `banner/banner-dark.png`, `banner-light.png` | README banner, 2560 × 1280. The README picks one by colour scheme |
| `banner/social-preview.png` | Repository social preview, 1280 × 640. Upload it under Settings, General, Social preview |

## Colour

| Name | Hex | Use |
|---|---|---|
| Ink | `#0B1020` | The ring on light backgrounds, and the dark background itself |
| Mist | `#EEF2F9` | The ring on dark backgrounds |
| Signal | `#0AA38F` | The chevron on light backgrounds. 3.2:1 against white, 6:1 against Ink |
| Signal, lifted | `#19C7AE` | The same accent for dark backgrounds, 8.8:1 against Ink |

## Rules

- Keep the ring neutral. Only the chevron carries colour.
- Leave a clear space of at least one ring thickness around the mark.
- The symbol was checked down to 16 px. Don't go smaller.
- Don't stretch, rotate, outline or add shadows or glows.

## Type

The wordmark is Outfit SemiBold (weight 650), set with kerning and converted to outlines, so
none of the files needs the font installed. The banner also uses JetBrains Mono for the
command names. Both are licensed under the SIL Open Font License 1.1.
