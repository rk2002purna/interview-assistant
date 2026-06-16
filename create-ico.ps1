# Run this script on Windows to create a proper multi-size .ico from icon.png
# Requirements: ImageMagick installed (https://imagemagick.org/script/download.php#windows)
# Usage: Right-click → Run with PowerShell (from the project root)

$inputPng = "build\icon.png"
$outputIco = "build\icon.ico"

if (-not (Test-Path $inputPng)) {
    Write-Host "ERROR: $inputPng not found." -ForegroundColor Red
    Write-Host "Place your 512x512 PNG at build\icon.png first." -ForegroundColor Yellow
    exit 1
}

# Check if ImageMagick is available
$magick = Get-Command magick -ErrorAction SilentlyContinue
if (-not $magick) {
    Write-Host "ImageMagick not found. Trying alternative method..." -ForegroundColor Yellow
    
    # Fallback: use .NET to create ico from the PNG
    Add-Type -AssemblyName System.Drawing

    $sizes = @(16, 32, 48, 64, 128, 256)
    $bitmaps = @()

    foreach ($size in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($size, $size)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $src = [System.Drawing.Image]::FromFile((Resolve-Path $inputPng))
        $g.DrawImage($src, 0, 0, $size, $size)
        $g.Dispose()
        $src.Dispose()
        $bitmaps += $bmp
    }

    # Write .ico manually
    $ms = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($ms)

    # ICO header
    $writer.Write([uint16]0)      # Reserved
    $writer.Write([uint16]1)      # Type: 1 = ICO
    $writer.Write([uint16]$bitmaps.Count) # Image count

    # Calculate offset: header (6) + directory entries (16 each)
    $offset = 6 + ($bitmaps.Count * 16)
    $imageData = @()

    foreach ($bmp in $bitmaps) {
        $imgMs = New-Object System.IO.MemoryStream
        $bmp.Save($imgMs, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $imgMs.ToArray()
        $imageData += ,$bytes
        $imgMs.Dispose()

        $w = if ($bmp.Width -eq 256) { 0 } else { [byte]$bmp.Width }
        $h = if ($bmp.Height -eq 256) { 0 } else { [byte]$bmp.Height }

        $writer.Write([byte]$w)
        $writer.Write([byte]$h)
        $writer.Write([byte]0)    # Color count
        $writer.Write([byte]0)    # Reserved
        $writer.Write([uint16]1)  # Color planes
        $writer.Write([uint16]32) # Bits per pixel
        $writer.Write([uint32]$bytes.Length)
        $writer.Write([uint32]$offset)
        $offset += $bytes.Length
    }

    foreach ($bytes in $imageData) {
        $writer.Write($bytes)
    }

    $writer.Flush()
    [System.IO.File]::WriteAllBytes((Resolve-Path "." ).Path + "\" + $outputIco, $ms.ToArray())
    $writer.Dispose()
    $ms.Dispose()
    foreach ($bmp in $bitmaps) { $bmp.Dispose() }

    Write-Host "SUCCESS: Created $outputIco using .NET method" -ForegroundColor Green
    exit 0
}

# ImageMagick method (best quality)
magick convert $inputPng -define icon:auto-resize=256,128,64,48,32,16 $outputIco
Write-Host "SUCCESS: Created $outputIco using ImageMagick" -ForegroundColor Green
