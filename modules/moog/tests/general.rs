use clawdio_moog::MoogModule;
use test_helpers::{generate_silence_samples, signal::generate_sine_wave, plotting::plot_waveform_comparison};

#[test]
fn test_silence_input() {
    let mut filter = MoogModule::new(0.5, 0.5);
    // Generate silence samples
    let silence = generate_silence_samples();
    
    // Run the filter process
    let result = filter.process_vec(silence);
    
    // Output should be close to zero for zero input
    for sample in result {
        assert!(sample.abs() < 0.001, "Sample too large: {}", sample);
    }
}

#[test]
fn test_impulse_response() {
    let mut filter = MoogModule::new(0.5, 0.1);
    // Generate a single impulse sample
    let mut impulse = vec![0.0; 128];
    impulse[0] = 1.0;
    
    let output = filter.process_vec(impulse);
    
    // First sample should be non-zero
    assert!(output[0] != 0.0);
    // Should decay over time (lowpass behavior)
    assert!(output[10].abs() < output[0].abs());
}

#[test]
fn test_no_nan_or_inf() {
    let mut filter = MoogModule::new(0.9, 0.9); // High settings
    // Generate sine wave samples
    let input_data: Vec<f32> = (0..128).map(|i| (i as f32 * 0.1).sin()).collect();
    
    let output = filter.process_vec(input_data);
    
    for (i, sample) in output.iter().enumerate() {
        assert!(sample.is_finite(), "Found NaN or Inf at index {}: {}", i, sample);
        assert!(sample.abs() < 10.0, "Output too large at index {}: {}", i, sample);
    }
}

#[test]
fn test_signal_effect() {
    let num_samples = 1024;
    let mut filter = MoogModule::new(0.7, 0.8);
    let original = generate_sine_wave(num_samples);
    let input = generate_sine_wave(num_samples);
    let output = filter.process_vec(input);

    // Visualize signal
    plot_waveform_comparison(
        &output,
        &original,
        num_samples as f32,
        "Moog Test - Comparison (Sine)",
    )
    .expect("Failed to create plot");
}

#[test]
fn test_stability_over_time() {
    let mut filter = MoogModule::new(0.7, 0.8);

    // Process many samples to test long-term stability
    // Ensures filter decays properly and doesn't go to infinity
    for _ in 0..10 {
        let input: Vec<f32> = (0..1024).map(|i| (i as f32 * 0.01).sin()).collect();
        let output = filter.process_vec(input);

        // Check last few samples are still reasonable
        for &sample in output.iter().rev().take(10) {
            assert!(sample.is_finite() && sample.abs() < 2.0);
        }
    }
}

#[test]
fn test_set_cutoff_changes_processing() {
    let num_samples = 512;
    // Two identical filters with identical state history
    let mut filter_a = MoogModule::new(0.3, 0.5);
    let mut filter_b = MoogModule::new(0.3, 0.5);

    // Sync their internal state with the same input
    let warmup = generate_sine_wave(num_samples);
    filter_a.process_vec(warmup.clone());
    filter_b.process_vec(warmup);

    // Update cutoff on one filter only
    filter_b.set_cutoff(0.9);
    assert_eq!(filter_b.get_cutoff(), 0.9);

    let input = generate_sine_wave(num_samples);
    let output_a = filter_a.process_vec(input.clone());
    let output_b = filter_b.process_vec(input);

    assert!(
        output_a.iter().zip(output_b.iter()).any(|(a, b)| a != b),
        "Changing cutoff should change the processed output"
    );
}

#[test]
fn test_set_resonance_changes_processing() {
    let num_samples = 512;
    let mut filter_a = MoogModule::new(0.5, 0.1);
    let mut filter_b = MoogModule::new(0.5, 0.1);

    let warmup = generate_sine_wave(num_samples);
    filter_a.process_vec(warmup.clone());
    filter_b.process_vec(warmup);

    filter_b.set_resonance(3.5);
    assert_eq!(filter_b.get_resonance(), 3.5);

    let input = generate_sine_wave(num_samples);
    let output_a = filter_a.process_vec(input.clone());
    let output_b = filter_b.process_vec(input);

    assert!(
        output_a.iter().zip(output_b.iter()).any(|(a, b)| a != b),
        "Changing resonance should change the processed output"
    );
}

#[test]
fn test_set_params_before_first_process() {
    // Simulates the worklet flow where parameter updates are cached
    // and applied to the module right after creation, before any processing
    let num_samples = 128;
    let mut impulse = vec![0.0; num_samples];
    impulse[0] = 1.0;

    let mut filter_default = MoogModule::new(0.1, 0.1);
    let mut filter_updated = MoogModule::new(0.1, 0.1);
    filter_updated.set_cutoff(0.8);
    filter_updated.set_resonance(2.0);

    let output_default = filter_default.process_vec(impulse.clone());
    let output_updated = filter_updated.process_vec(impulse);

    assert!(
        output_default
            .iter()
            .zip(output_updated.iter())
            .any(|(a, b)| a != b),
        "Params set before the first process call should affect the very first block"
    );
}