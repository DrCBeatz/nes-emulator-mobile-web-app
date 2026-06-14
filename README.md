# 8-Bit Pocket

A mobile-friendly 8-bit emulator web app powered by [JSNES](https://github.com/bfirsh/jsnes). The current app targets NES hardware, runs fully in the browser, opens local `.nes` files without uploading them anywhere, includes touch controls modeled after the original NES controller, and can be deployed as a static website.

## Features

- Browser-based NES hardware emulation with JSNES
- Mobile touch controls for D-pad, A, B, Select, and Start
- Local ROM loading from the user's device
- Optional hosted ROM list via `public/roms/manifest.json`
- Static build output suitable for S3, CloudFront, GitHub Pages, Netlify, or similar hosting

## ROMs

This repository does not include game ROMs. Use public-domain, homebrew, or otherwise legally licensed ROM files.

Local test ROMs are ignored by git through `.gitignore`.

## Development

```sh
npm install
npm run dev
```

Open the local URL shown by Vite, then use **Open ROM** to load a `.nes` file from your device.

## Hosted ROMs

To provide a hosted ROM picker, place licensed ROM files in `public/roms/` and list them in `public/roms/manifest.json`:

```json
[
  {
    "title": "Example Homebrew",
    "url": "/roms/example.nes"
  }
]
```

ROM files are ignored by default, so remove or narrow the ROM ignore rules only if you intentionally want to commit legally redistributable ROMs.

## Build

```sh
npm run build
```

The static site is generated in `dist/`.

## S3 Deploy

```sh
aws s3 sync dist s3://nes-emulator-mobile-web-app --delete
```

For a public S3 website bucket, the bucket needs public object read access:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadForStaticWebsite",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::nes-emulator-mobile-web-app/*"
    }
  ]
}
```

## License

MIT
