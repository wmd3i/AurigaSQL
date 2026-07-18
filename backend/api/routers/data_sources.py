from fastapi import APIRouter

from api import handlers

router = APIRouter()
router.add_api_route("/data-sources", handlers.data_sources, methods=["GET"])
router.add_api_route("/data-sources/demo", handlers.demo_data_sources, methods=["GET"])
router.add_api_route("/data-sources/resolve", handlers.resolve_data_source_for_query, methods=["POST"])
router.add_api_route("/demo-connections", handlers.demo_connections, methods=["GET"])
router.add_api_route("/demo-connections", handlers.save_demo_connection, methods=["POST"])
router.add_api_route(
    "/demo-connections/disconnect",
    handlers.remove_demo_connection,
    methods=["POST"],
)
router.add_api_route("/connections", handlers.connections, methods=["GET"])
router.add_api_route("/connections/test", handlers.test_connection, methods=["POST"])
router.add_api_route("/connections/import-file", handlers.import_connection_file, methods=["POST"])
router.add_api_route("/connections", handlers.save_connection, methods=["POST"])
router.add_api_route("/connections/{connection_id}", handlers.patch_connection, methods=["PATCH"])
router.add_api_route("/connections/{connection_id}", handlers.remove_connection, methods=["DELETE"])
router.add_api_route("/databases/{database}/schema", handlers.database_schema, methods=["GET"])
router.add_api_route("/tasks", handlers.tasks, methods=["GET"])
