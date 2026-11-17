"""Opt-in smoke test using cached weights and an existing audio fixture, without downloading."""
import asyncio
import math
import os
from pathlib import Path
import unittest
import main

MODEL_DIR = os.environ.get("ZHENGYIN_TEST_MODEL_DIR")
AUDIO_FILE = os.environ.get("ZHENGYIN_TEST_AUDIO")

@unittest.skipUnless(MODEL_DIR and AUDIO_FILE, "set cached model directory and audio fixture to run")
class RealModelContract(unittest.TestCase):
    def test_cached_weights_produce_finite_phone_confidences(self):
        main._load(MODEL_DIR, offline=True)
        class AudioRequest:
            async def stream(self):
                yield Path(AUDIO_FILE).read_bytes()
        result = asyncio.run(main.recognize(AudioRequest()))
        self.assertTrue(result["ipa"].strip())
        self.assertGreater(result["seconds"], 0)
        self.assertLessEqual(result["seconds"], main.MAX_SECONDS)
        self.assertTrue(result["phones"])
        for phone in result["phones"]:
            self.assertTrue(phone["ipa"])
            self.assertTrue(math.isfinite(phone["conf"]))
            self.assertGreaterEqual(phone["conf"], 0)
            self.assertLessEqual(phone["conf"], 1)

if __name__ == "__main__":
    unittest.main()
