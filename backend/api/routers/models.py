from fastapi import APIRouter

from api import handlers

router = APIRouter()
router.add_api_route("/models", handlers.models, methods=["GET"])
router.add_api_route("/llm/configs", handlers.llm_configs, methods=["GET"])
router.add_api_route("/llm/configs", handlers.create_llm_config, methods=["POST"])
router.add_api_route("/llm/configs/{profile_id}", handlers.update_llm_config, methods=["PATCH"])
router.add_api_route("/llm/configs/{profile_id}", handlers.delete_llm_config, methods=["DELETE"])
router.add_api_route("/llm/configs/default", handlers.set_llm_default, methods=["POST"])
router.add_api_route("/llm/configs/{profile_id}/test", handlers.test_llm_config, methods=["POST"])
router.add_api_route("/llm/configs/test", handlers.test_llm_config_draft, methods=["POST"])
router.add_api_route("/local-model/status", handlers.local_model_status, methods=["GET"])
router.add_api_route("/local-model/setup", handlers.setup_local_model, methods=["POST"])
