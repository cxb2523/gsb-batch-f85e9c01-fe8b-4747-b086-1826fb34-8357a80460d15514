use clawdio_bitcrusher::BitcrusherModule;
use test_helpers::{signal::generate_sine_wave, plotting::plot_waveform_comparison};

#[test]
fn test_signal_effect() {
    let num_samples = 1024;
    let mut filter = BitcrusherModule::new(4);
    let original = generate_sine_wave(num_samples);
    let input = generate_sine_wave(num_samples);
    let output = filter.process_vec(input, 0.420);

    // Bitcrusher creates a step-like pattern out of input signal
    // Technically the modified signal will be equal sometimes, but mostly not
    // So we check that (mostly) every point in signal is different
    let mut is_equal = 0;
    let mut is_diff = 0;
    for index in 0..original.len() {
        let sample_original = original[index];
        let sample_effect = output[index];

        if sample_original != sample_effect {
            is_diff += 1;
        } else {
            is_equal += 1;
        }
    }
    assert!(is_diff > is_equal, "Values should be less equal");


    // Visualize signal
    plot_waveform_comparison(
        &output,
        &original,
        num_samples as f32,
        "Bitcrusher Test - Comparison (Sine)",
    )
    .expect("Failed to create plot");
}

#[test]
fn test_set_bits_changes_quantization_step() {
    let num_samples = 1024;
    // normfreq = 1.0 so every sample is quantized (no sample-and-hold holdover)
    let normfreq = 1.0;

    let mut filter = BitcrusherModule::new(4);
    let output_4bit = filter.process_vec(generate_sine_wave(num_samples), normfreq);

    // Update bits at runtime - the quantization step must change
    filter.set_bits(1);
    assert_eq!(filter.get_bits(), 1);
    let output_1bit = filter.process_vec(generate_sine_wave(num_samples), normfreq);

    // Outputs before/after the update must differ
    assert!(
        output_4bit
            .iter()
            .zip(output_1bit.iter())
            .any(|(a, b)| a != b),
        "Changing bits should change the processed output"
    );

    // With bits = 1 the quantization step is 0.5^1 = 0.5,
    // so every output sample must be a multiple of 0.5
    for (i, sample) in output_1bit.iter().enumerate() {
        let ratio = sample / 0.5;
        assert!(
            (ratio - ratio.round()).abs() < 1e-5,
            "Sample {} ({}) is not quantized to the 1-bit step (0.5)",
            i,
            sample
        );
    }
}

#[test]
fn test_set_bits_before_first_process() {
    // Simulates the worklet flow where a parameter update is cached
    // and applied to the module right after creation, before any processing
    let num_samples = 256;
    let normfreq = 1.0;

    let mut filter = BitcrusherModule::new(8);
    filter.set_bits(2);

    let output = filter.process_vec(generate_sine_wave(num_samples), normfreq);

    // With bits = 2 the quantization step is 0.5^2 = 0.25
    for (i, sample) in output.iter().enumerate() {
        let ratio = sample / 0.25;
        assert!(
            (ratio - ratio.round()).abs() < 1e-5,
            "First process after set_bits should already use the new step: sample {} ({})",
            i,
            sample
        );
    }
}