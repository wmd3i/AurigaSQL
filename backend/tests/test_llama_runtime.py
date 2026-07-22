from pathlib import Path
import unittest

from shared.llama_runtime import platform_runtime_relative_path


class PlatformRuntimeRelativePathTests(unittest.TestCase):
    def test_macos_arm64(self) -> None:
        self.assertEqual(
            platform_runtime_relative_path("Darwin", "arm64"),
            Path("macos-arm64/llama-server"),
        )

    def test_macos_x64(self) -> None:
        self.assertEqual(
            platform_runtime_relative_path("Darwin", "x86_64"),
            Path("macos-x64/llama-server"),
        )

    def test_windows_x64(self) -> None:
        self.assertEqual(
            platform_runtime_relative_path("Windows", "AMD64"),
            Path("windows-x64/llama-server.exe"),
        )

    def test_unsupported_platform_reports_detected_values(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "Linux.*riscv64"):
            platform_runtime_relative_path("Linux", "riscv64")


if __name__ == "__main__":
    unittest.main()
