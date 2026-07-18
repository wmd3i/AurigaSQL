from fastapi import APIRouter

from api import handlers

router = APIRouter()
router.add_api_route("/freechat/start", handlers.freechat_start, methods=["POST"])
router.add_api_route("/turn", handlers.turn, methods=["POST"])
router.add_api_route("/answer_user", handlers.answer_user, methods=["POST"])
router.add_api_route("/cancel", handlers.cancel_turn, methods=["POST"])
router.add_api_route("/events/{task_id}", handlers.events_proxy, methods=["GET"])
router.add_api_route("/session/{task_id}", handlers.session_snapshot, methods=["GET"])
router.add_api_route("/cleanup/{task_id}", handlers.cleanup, methods=["POST"])
