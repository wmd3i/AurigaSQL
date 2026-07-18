from fastapi import APIRouter

from api import handlers

router = APIRouter()
router.add_api_route("/title", handlers.title, methods=["POST"])
router.add_api_route("/analyze", handlers.analyze, methods=["POST"])
router.add_api_route("/branch/answer", handlers.branch_answer, methods=["POST"])
router.add_api_route("/visualize", handlers.visualize, methods=["POST"])
