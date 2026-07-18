from fastapi import APIRouter

from api import handlers

router = APIRouter()
router.add_api_route("/health", handlers.health, methods=["GET"])
