"""
Floorplan API endpoints for uploading, retrieving, and deleting floorplan images.
Uses GridFS for storage and pypdfium2 for PDF-to-image conversion.
"""

import io
import logging
from typing import Optional

from bson import ObjectId
from flask import Blueprint, Response, request, jsonify, send_file
from flask_login import login_required
from PIL import Image as PILImage

from api.floorplans_access import image_asking, image_refusal, market_refusal
import api.market_actions as Actions
from client_errors import traceback_without_messages
import floorplan_limits as Limits
import history as History
from services.gridfs_service import delete_image, get_image, upload_image
from utils.pdf_converter import TooManyPages, UnreadablePdf, pdf_to_images

logger = logging.getLogger(__name__)

floorplans_bp = Blueprint("floorplans", __name__)


def _get_image_dimensions(image_data: bytes):
    """Extract (width, height) from image bytes using PIL.
    Returns (0, 0) if the data is not parseable as an image.
    """
    try:
        img = PILImage.open(io.BytesIO(image_data))
        return img.size  # (width, height)
    except Exception as exc:
        logger.warning("Could not determine image dimensions: %s", type(exc).__name__)
        return (0, 0)


def detect_mimetype(image_data: bytes) -> str:
    """Detect image MIME type from raw bytes using PIL.
    Falls back to 'image/png' when detection fails.
    """
    try:
        img = PILImage.open(io.BytesIO(image_data))
        fmt = img.format
        if fmt:
            return f"image/{fmt.lower()}"
    except Exception:
        pass
    return "image/png"


PDF = "application/pdf"

# Where a PDF's header may stand: PDF readers look for it within a file's first 1024 bytes.
PDF_HEADER_WITHIN = 1024

NOT_A_FLOORPLAN = "This file is not a PNG, JPG, WebP or PDF."


def uploaded_type(data: bytes) -> Optional[str]:
    """The floorplan type ``data`` is by its own first bytes: PNG, JPEG, WebP or PDF, else None.

    The type and the name a client sends with a file are its word, not the file's, so the upload
    reads neither to decide what it stores or how it draws it.
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if b"%PDF-" in data[:PDF_HEADER_WITHIN]:
        return PDF
    return None


def _sent_as_pdf(file) -> bool:
    """Whether the client called the file a PDF: it chooses only the words of a refusal."""
    return (file.content_type or "").lower() == PDF or (file.filename or "").lower().endswith(".pdf")


# ── POST /api/floorplans/upload ──────────────────────────────────────────────

@floorplans_bp.route("/upload", methods=["POST"])
@login_required
def upload_floorplan():
    """Accept a multipart file upload (image or PDF) for a market.

    The ``market_id`` form field names the market the image is for: the caller must be an editor
    of it, on a market that is not archived, and every stored image remembers it.

    The file's type is read from its own first bytes (``uploaded_type``), never from the type or
    the name the client sent: bytes that are none of PNG, JPEG, WebP or PDF are refused 400
    ``NOT_A_FLOORPLAN``, or the unreadable PDF's sentence when the client called the file a PDF.

    - Image: stores directly in GridFS, returns ``{gridfs_id, width, height}``.
    - PDF: converts each page via ``pdf_to_images``, stores each page
      separately, returns ``{pages: [{gridfs_id, width, height}, ...]}``.

    Held to production's limits (T257): a file over ``MAX_UPLOAD_BYTES`` is refused 413, by the
    request's ``Content-Length`` before the body is read when it says so, and by the file's own
    length when it does not; a PDF of more than ``MAX_PDF_PAGES`` pages, or one PDFium cannot open,
    is refused 400 with a sentence, the latter naming the file.
    """
    length = request.content_length
    if length is not None and length > Limits.MAX_UPLOAD_BYTES + Limits.UPLOAD_FORM_ALLOWANCE_BYTES:
        return jsonify({"error": Limits.UPLOAD_TOO_LARGE}), 413
    try:
        market_id = request.form.get("market_id")
        refusal = market_refusal(market_id, Actions.CHANGE_SETUP, edits=True)
        if refusal:
            return refusal

        file = request.files.get("file")
        if not file:
            return jsonify({"error": "No file provided"}), 400

        file_bytes = file.read()
        if not file_bytes:
            return jsonify({"error": "Empty file"}), 400
        if len(file_bytes) > Limits.MAX_UPLOAD_BYTES:
            return jsonify({"error": Limits.UPLOAD_TOO_LARGE}), 413

        filename = file.filename or "floorplan"
        kind = uploaded_type(file_bytes)
        if kind is None:
            if _sent_as_pdf(file):
                return jsonify({"error": Limits.unreadable_pdf(filename)}), 400
            return jsonify({"error": NOT_A_FLOORPLAN}), 400

        # ── PDF path ───────────────────────────────────────────────────
        if kind == PDF:
            try:
                page_images = pdf_to_images(
                    file_bytes, max_pages=Limits.MAX_PDF_PAGES,
                    max_side_px=Limits.MAX_PDF_PAGE_SIDE_PX)
            except TooManyPages:
                return jsonify({"error": Limits.TOO_MANY_PDF_PAGES}), 400
            except UnreadablePdf as exc:
                logger.info("Refused an unreadable PDF for market %s: %s", market_id, exc)
                return jsonify({"error": Limits.unreadable_pdf(filename)}), 400

            pages = []
            for i, page_bytes in enumerate(page_images):
                page_filename = f"{filename}_page_{i + 1}.png"
                gridfs_id = upload_image(page_bytes, page_filename, market_id)
                width, height = _get_image_dimensions(page_bytes)
                pages.append({
                    "gridfs_id": gridfs_id,
                    "width": width,
                    "height": height,
                })

            return jsonify({"pages": pages}), 201

        # ── Image path ─────────────────────────────────────────────────
        gridfs_id = upload_image(file_bytes, filename, market_id)
        width, height = _get_image_dimensions(file_bytes)
        return jsonify({
            "gridfs_id": gridfs_id,
            "width": width,
            "height": height,
        }), 201

    except Exception as exc:
        logger.error("Error uploading floorplan\n%s", traceback_without_messages(exc))
        return jsonify({"error": "Internal server error"}), 500


# ── GET /api/floorplans/<gridfs_id> ──────────────────────────────────────────

@floorplans_bp.route("/<gridfs_id>", methods=["GET"])
@login_required
def get_floorplan(gridfs_id: str):
    """Retrieve a floorplan image by its GridFS ObjectId.

    The image is read on the market it was uploaded for, by anyone the Read row lets in (any role
    on it), an archived market's too. To anyone else, and for an unknown image or one stored
    without a market, the image is not there: every refusal answers 404 "Image not found", so the
    answer never tells a stranger that an id names an image.

    The browser alone keeps the image, and asks about its copy on every use (T501): the answer is
    ``Cache-Control: private, no-cache`` with a strong ``ETag`` of the image's id, since the bytes
    under an id never change (a replaced floorplan gets a new id). A request whose ``If-None-Match``
    names that tag, its weak form or ``*`` gets ``304`` with no body, after the access check and
    without reading the image, so a reload downloads no body. ``private`` keeps it out of any shared
    cache; no ``max-age`` is given, since the browser would then use its copy unasked and show it to
    a person who lost their role, or to the next person on a shared device, until it ran out. A
    refusal is the same 404 with or without a tag, so a tag reveals nothing, and a signed-out
    request is the 401 every floorplan route answers.
    """
    if image_refusal(gridfs_id, Actions.READ, edits=False):
        return jsonify({"error": "Image not found"}), 404

    tag = str(ObjectId(gridfs_id))
    if request.if_none_match.contains_weak(tag):
        unchanged = Response(status=304)
        return _asked_about_again(unchanged, tag)

    image_data = get_image(gridfs_id)
    if image_data is None:
        return jsonify({"error": "Image not found"}), 404

    mimetype = detect_mimetype(image_data)
    return _asked_about_again(send_file(io.BytesIO(image_data), mimetype=mimetype), tag)


def _asked_about_again(response: Response, tag: str) -> Response:
    """The signed-in image's cache rule on ``response``: kept by the browser alone, asked about on
    every use, by its tag."""
    response.headers["Cache-Control"] = "private, no-cache"
    response.set_etag(tag)
    return response


# ── DELETE /api/floorplans/<gridfs_id> ───────────────────────────────────────

@floorplans_bp.route("/<gridfs_id>", methods=["DELETE"])
@login_required
def delete_floorplan(gridfs_id: str):
    """Delete a floorplan image from GridFS.

    The caller must be an editor of the image's market, on a market that is not archived.
    """
    try:
        asked, refusal = image_asking(gridfs_id, Actions.CHANGE_SETUP, edits=True)
        if refusal:
            return refusal

        success = delete_image(gridfs_id)
        if not success:
            return jsonify({"error": "Image not found"}), 404
        asked.record(
            kind=History.FLOORPLAN_IMAGE_DELETED, subject={"image_id": gridfs_id},
            detail=lambda: History.changes({"image_id": gridfs_id}, {"image_id": None}),
        )

        return jsonify({"message": "Image deleted successfully"}), 200

    except Exception as exc:
        logger.error("Error deleting floorplan %s\n%s", gridfs_id, traceback_without_messages(exc))
        return jsonify({"error": "Internal server error"}), 500
