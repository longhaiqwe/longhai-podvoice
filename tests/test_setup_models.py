import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("setup_models", ROOT / "setup_models.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class ModelSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.target = self.root / "service"
        self.archive = self.root / "models.zip"
        self.contents = {
            "GPT_weights/voice.ckpt": b"gpt-test",
            "SoVITS_weights/voice.pth": b"sovits-test",
            "reference_audio/voice.wav": b"reference-test",
        }
        targets = [
            ["GPT_weights_v2/voice.ckpt"],
            ["SoVITS_weights_v2/voice.pth"],
            ["reference_audio/voice.wav", "dataset/voice/wavs/voice.wav"],
        ]
        self.manifest = {
            "schema_version": 1,
            "voices": {"voice": {"request": {
                "gpt_weights_path": targets[0][0],
                "sovits_weights_path": targets[1][0],
                "ref_audio_path": targets[2][0],
                "prompt_text": "参考文本。", "prompt_lang": "zh",
            }}},
            "files": [{"archive_path": name, "install_paths": target,
                       "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
                      for (name, content), target in zip(self.contents.items(), targets)],
        }
        self.write_zip()

    def write_zip(self, extra=None, symlink=None, changed_manifest=None):
        with zipfile.ZipFile(self.archive, "w") as bundle:
            bundle.writestr("manifest.json", json.dumps(changed_manifest or self.manifest))
            for name, content in self.contents.items():
                info = zipfile.ZipInfo(name)
                if name == symlink:
                    info.create_system = 3
                    info.external_attr = 0o120777 << 16
                bundle.writestr(info, content)
            if extra:
                bundle.writestr(extra, b"unexpected")

    def test_local_install_aliases_configs_and_repeat(self):
        first = setup.install(self.archive, self.target, self.manifest, "mps")
        self.assertEqual(first, {"verified_files": 3, "installed": 6, "unchanged": 0})
        self.assertEqual((self.target / "dataset/voice/wavs/voice.wav").read_bytes(), b"reference-test")
        self.assertIn('device: "mps"', (self.target / "podvoice-configs/voice.yaml").read_text())
        self.assertEqual(setup.install(self.archive, self.target, self.manifest, "mps")["unchanged"], 6)

    def test_conflict_does_not_write_any_other_file(self):
        existing = self.target / "reference_audio/voice.wav"
        existing.parent.mkdir(parents=True)
        existing.write_bytes(b"user-file")
        with self.assertRaisesRegex(ValueError, "内容不同"):
            setup.install(self.archive, self.target, self.manifest)
        self.assertEqual(existing.read_bytes(), b"user-file")
        self.assertFalse((self.target / "GPT_weights_v2").exists())

    def test_tampered_payload_rejected_before_target_creation(self):
        self.contents["GPT_weights/voice.ckpt"] = b"bad-test"
        self.write_zip()
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            setup.install(self.archive, self.target, self.manifest)
        self.assertFalse(self.target.exists())

    def test_zip_checksum_rejected(self):
        with self.assertRaisesRegex(ValueError, "ZIP SHA-256"):
            setup.install(self.archive, self.target, self.manifest, expected_sha256="0" * 64)
        self.assertFalse(self.target.exists())

    def test_zip_path_traversal_and_unexpected_file_rejected(self):
        for name in ("../escape", "/escape", "extra.txt"):
            with self.subTest(name=name):
                self.write_zip(extra=name)
                with self.assertRaises(ValueError):
                    setup.install(self.archive, self.target, self.manifest)
        self.assertFalse(self.target.exists())

    def test_zip_symlink_rejected(self):
        self.write_zip(symlink="GPT_weights/voice.ckpt")
        with self.assertRaisesRegex(ValueError, "非普通文件"):
            setup.install(self.archive, self.target, self.manifest)

    def test_target_symlink_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.target.mkdir()
        (self.target / "GPT_weights_v2").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "符号链接"):
            setup.install(self.archive, self.target, self.manifest)
        self.assertEqual(list(outside.iterdir()), [])

    def test_external_manifest_cannot_change_install_path(self):
        changed = json.loads(json.dumps(self.manifest))
        changed["files"][0]["install_paths"] = ["../outside"]
        self.write_zip(changed_manifest=changed)
        with self.assertRaisesRegex(ValueError, "清单不一致"):
            setup.install(self.archive, self.target, self.manifest)

    def test_manifest_rejects_unsafe_install_path(self):
        self.manifest["files"][0]["install_paths"] = ["../outside"]
        path = self.root / "manifest.json"
        path.write_text(json.dumps(self.manifest))
        with self.assertRaisesRegex(ValueError, "非法相对路径"):
            setup.read_manifest(path)

    def test_download_then_install_over_local_http(self):
        directory = str(self.root)

        class Handler(SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=directory, **kwargs)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            output = self.root / "download.zip"
            setup.download(f"http://127.0.0.1:{server.server_port}/models.zip", output)
            self.assertEqual(setup.sha256(output), setup.sha256(self.archive))
            self.assertEqual(setup.install(output, self.target, self.manifest)["installed"], 6)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
