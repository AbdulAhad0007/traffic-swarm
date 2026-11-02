"""Live Camera (LCM): camera ingestion, detection, traffic analytics and signal proposals.

A service of its own (port 8091), so a camera or model failure can never affect the simulation lab.
Run it with: uvicorn camera_service.api:app --port 8091
"""
