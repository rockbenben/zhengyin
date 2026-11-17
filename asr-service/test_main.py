import asyncio
import io
import unittest
from unittest.mock import patch
import numpy as np
import soundfile as sf
import torch
import main
from fastapi import HTTPException

class AudioContract(unittest.TestCase):
    def wav(self, seconds=1, sr=8000):
        output = io.BytesIO()
        sf.write(output, np.zeros((int(seconds * sr), 2), dtype="float32"), sr, format="WAV")
        return output.getvalue()

    def test_resamples_stereo(self):
        audio = main.to_mono_16k(self.wav())
        self.assertEqual(audio.shape, (16000,))
        self.assertEqual(audio.dtype, np.float32)

    def test_rejects_duration_before_decode(self):
        with self.assertRaises(ValueError):
            main.to_mono_16k(self.wav(31))

    def test_duration_limit_response_before_decode(self):
        for seconds in (30 + 1 / 8000, 31):
            with self.subTest(seconds=seconds):
                raw = self.wav(seconds)
                class Request:
                    async def stream(self):
                        yield raw
                with patch.dict(main._state, {"model": object()}, clear=True), patch.object(main.sf, "read") as decode:
                    with self.assertRaises(HTTPException) as error:
                        asyncio.run(main.recognize(Request()))
                    self.assertEqual(error.exception.status_code, 413)
                    self.assertEqual(error.exception.detail, "音频超过 30s")
                    decode.assert_not_called()

    def test_exact_duration_limit_is_accepted(self):
        self.assertEqual(main.to_mono_16k(self.wav(30)).shape, (480000,))

    def test_bad_audio_remains_400(self):
        class Request:
            async def stream(self):
                yield b"not audio"
        with patch.dict(main._state, {"model": object()}, clear=True):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(main.recognize(Request()))
            self.assertEqual(error.exception.status_code, 400)
            self.assertIn("这段音频解不开", error.exception.detail)

    def test_ctc_blank_and_repetition(self):
        class Processor:
            class tokenizer:
                @staticmethod
                def get_vocab():
                    return {"blank": 0, "k": 1, "t": 2}
        class Model:
            class config:
                pad_token_id = 0
        old = dict(main._state)
        try:
            main._state.update(model=Model(), processor=Processor())
            logits = torch.tensor([[0.,5.,0.],[0.,5.,0.],[5.,0.,0.],[0.,0.,5.]])
            self.assertEqual([x["ipa"] for x in main.phone_confidences(logits)], ["k", "t"])
        finally:
            main._state.clear()
            main._state.update(old)

    def test_stream_limit_before_decoder(self):
        class Request:
            async def stream(self):
                yield b"x" * (main.MAX_BYTES + 1)
        old = dict(main._state)
        try:
            main._state["model"] = object()
            with self.assertRaises(HTTPException) as error:
                asyncio.run(main.recognize(Request()))
            self.assertEqual(error.exception.status_code, 413)
        finally:
            main._state.clear()
            main._state.update(old)

if __name__ == "__main__":
    unittest.main()
