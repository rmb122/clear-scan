# DocShadow SD7K FP16

The optional advanced shadow-removal model is a float16 conversion of
`docshadow_sd7k.onnx` from `fabio-sim/DocShadow-ONNX-TensorRT`, based on the
FSENet/SD7K work from `CXH-Research/DocShadow-SD7K`. Both source repositories
are MIT licensed. The app verifies the bundled model against the SHA-256 value
declared in `src/lib/advanced-model.ts` before enabling it.

The model is deliberately excluded from the service-worker precache. It is
copied into IndexedDB only after the user chooses Install in Settings.
