package youtrack

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"strings"
)

// PreparedImage is an attachment image ready to be returned to an LLM.
type PreparedImage struct {
	Data       []byte
	MimeType   string
	Width      int
	Height     int
	Downscaled bool
}

// PrepareImageForLLM normalises an image attachment so it fits in an MCP
// image content block:
//   - PNG/JPEG/GIF whose longest side exceeds maxDim, or whose bytes exceed
//     maxBytes, are downscaled (box filter, stdlib only) and re-encoded as JPEG.
//   - WebP has no stdlib decoder, so it's passed through only when already
//     under maxBytes.
//
// Returns an error when the image can't be brought under maxBytes.
func PrepareImageForLLM(data []byte, mime string, maxBytes int, maxDim int) (*PreparedImage, error) {
	mime = strings.ToLower(strings.TrimSpace(strings.SplitN(mime, ";", 2)[0]))
	if mime == "image/jpg" {
		mime = "image/jpeg"
	}
	if mime == "image/webp" {
		if len(data) > maxBytes {
			return nil, fmt.Errorf("webp is %d bytes, over the %d byte limit (webp can't be downscaled)", len(data), maxBytes)
		}
		return &PreparedImage{Data: data, MimeType: mime}, nil
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("not a decodable image: %w", err)
	}
	// Trust the actual bytes over the declared mime type.
	realMime := "image/" + format
	if cfg.Width <= maxDim && cfg.Height <= maxDim && len(data) <= maxBytes {
		return &PreparedImage{Data: data, MimeType: realMime, Width: cfg.Width, Height: cfg.Height}, nil
	}
	// Guard against decompression bombs before a full decode.
	if cfg.Width*cfg.Height > 50_000_000 {
		return nil, fmt.Errorf("image is %dx%d, too large to process", cfg.Width, cfg.Height)
	}

	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("failed to decode image: %w", err)
	}
	for _, dim := range []int{maxDim, maxDim * 3 / 4, maxDim / 2} {
		dst := downscale(src, dim)
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82}); err != nil {
			return nil, fmt.Errorf("failed to encode jpeg: %w", err)
		}
		if buf.Len() <= maxBytes {
			b := dst.Bounds()
			return &PreparedImage{Data: buf.Bytes(), MimeType: "image/jpeg", Width: b.Dx(), Height: b.Dy(), Downscaled: true}, nil
		}
	}
	return nil, fmt.Errorf("image still over %d bytes after downscaling", maxBytes)
}

// downscale shrinks src so its longest side is at most maxDim, averaging each
// source block (box filter). Transparent pixels are composited onto white,
// since the result is encoded as JPEG.
func downscale(src image.Image, maxDim int) *image.RGBA {
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	dw, dh := sw, sh
	if sw > maxDim || sh > maxDim {
		if sw >= sh {
			dw, dh = maxDim, max(1, sh*maxDim/sw)
		} else {
			dw, dh = max(1, sw*maxDim/sh), maxDim
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		y0 := sb.Min.Y + y*sh/dh
		y1 := max(y0+1, sb.Min.Y+(y+1)*sh/dh)
		for x := 0; x < dw; x++ {
			x0 := sb.Min.X + x*sw/dw
			x1 := max(x0+1, sb.Min.X+(x+1)*sw/dw)
			var r, g, b, n uint64
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					cr, cg, cb, ca := src.At(sx, sy).RGBA()
					// Composite premultiplied colour over white.
					inv := 0xffff - uint64(ca)
					r += uint64(cr) + inv
					g += uint64(cg) + inv
					b += uint64(cb) + inv
					n++
				}
			}
			dst.SetRGBA(x, y, color.RGBA{uint8(r / n >> 8), uint8(g / n >> 8), uint8(b / n >> 8), 0xff})
		}
	}
	return dst
}

// Register decoders used by image.DecodeConfig / image.Decode.
var _ = gif.Decode
var _ = png.Decode
