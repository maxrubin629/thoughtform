from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT.parent / "mindmap-ui-concepts"
QA = ROOT / "qa"
TARGET_SIZE = (1440, 1024)


def make_comparison(source_name: str, implementation_name: str, output_name: str) -> None:
    source = Image.open(SOURCE_ROOT / source_name).convert("RGB").resize(TARGET_SIZE, Image.Resampling.LANCZOS)
    implementation = Image.open(QA / implementation_name).convert("RGB").resize(TARGET_SIZE, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (TARGET_SIZE[0] * 2, TARGET_SIZE[1] + 42), "#111218")
    canvas.paste(source, (0, 42))
    canvas.paste(implementation, (TARGET_SIZE[0], 42))
    draw = ImageDraw.Draw(canvas)
    font = ImageFont.load_default(size=18)
    draw.text((20, 12), "SOURCE", fill="#ffffff", font=font)
    draw.text((TARGET_SIZE[0] + 20, 12), "IMPLEMENTATION", fill="#ffffff", font=font)
    canvas.save(QA / output_name, quality=94)


make_comparison("organic-paper-studio.png", "paper-final.png", "paper-comparison.jpg")
make_comparison("nocturne-focus-canvas.png", "nocturne-final.png", "nocturne-comparison.jpg")
