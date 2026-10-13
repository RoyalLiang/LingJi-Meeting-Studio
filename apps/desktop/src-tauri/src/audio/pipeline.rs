use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

pub const RATE: u32 = 16_000;
const BLOCK: usize = 1024;

pub struct Pipeline {
    rate: u32,
    channels: usize,
    resampler: Option<SincFixedIn<f32>>,
    input: Vec<f32>,
    output: Vec<i16>,
    received: u64,
    produced: u64,
    delay: usize,
    sequence: u32,
    offset: u32,
}

impl Pipeline {
    pub fn new(rate: u32, channels: usize) -> Result<Self, String> {
        if !(8_000..=192_000).contains(&rate) || !(1..=8).contains(&channels) {
            return Err("不支持此音频采样率或声道数".into());
        }
        let resampler = if rate == RATE {
            None
        } else {
            Some(
                SincFixedIn::new(
                    RATE as f64 / rate as f64,
                    1.0,
                    SincInterpolationParameters {
                        sinc_len: 128,
                        f_cutoff: 0.95,
                        interpolation: SincInterpolationType::Linear,
                        oversampling_factor: 128,
                        window: WindowFunction::BlackmanHarris2,
                    },
                    BLOCK,
                    1,
                )
                .map_err(|e| e.to_string())?,
            )
        };
        let delay = resampler.as_ref().map_or(0, |r| r.output_delay());
        Ok(Self {
            rate,
            channels,
            resampler,
            input: Vec::new(),
            output: Vec::new(),
            received: 0,
            produced: 0,
            delay,
            sequence: 0,
            offset: 0,
        })
    }

    pub fn push(&mut self, data: &[f32]) -> Result<Vec<Vec<u8>>, String> {
        if !data.len().is_multiple_of(self.channels) {
            return Err("音频帧不完整".into());
        }
        for frame in data.chunks_exact(self.channels) {
            self.input.push(
                frame
                    .iter()
                    .map(|x| if x.is_finite() { *x } else { 0.0 })
                    .sum::<f32>()
                    / self.channels as f32,
            );
            self.received += 1;
        }
        self.process(false)?;
        Ok(self.packets(false))
    }

    fn append(&mut self, samples: &[f32]) {
        let skip = self.delay.min(samples.len());
        self.delay -= skip;
        for value in &samples[skip..] {
            self.output
                .push((value.clamp(-1.0, 1.0) * 32767.0).round() as i16);
            self.produced += 1;
        }
    }

    fn process(&mut self, finish: bool) -> Result<(), String> {
        if self.resampler.is_none() {
            let input = std::mem::take(&mut self.input);
            self.append(&input);
            return Ok(());
        }
        while self.input.len() >= BLOCK {
            let block: Vec<_> = self.input.drain(..BLOCK).collect();
            let output = self
                .resampler
                .as_mut()
                .unwrap()
                .process(&[block], None)
                .map_err(|e| e.to_string())?;
            self.append(&output[0]);
        }
        if finish {
            let expected = self.received * RATE as u64 / self.rate as u64;
            while self.produced < expected {
                let mut block = std::mem::take(&mut self.input);
                block.resize(BLOCK, 0.0);
                let output = self
                    .resampler
                    .as_mut()
                    .unwrap()
                    .process(&[block], None)
                    .map_err(|e| e.to_string())?;
                let skip = self.delay.min(output[0].len());
                let need = (expected - self.produced) as usize;
                let take = output[0].len().min(skip + need);
                self.append(&output[0][..take]);
            }
        }
        Ok(())
    }

    fn packets(&mut self, finish: bool) -> Vec<Vec<u8>> {
        let mut result = Vec::new();
        loop {
            let target = if self.sequence == 0 {
                6_400
            } else {
                RATE as usize
            };
            if self.output.len() < target && (!finish || self.output.is_empty()) {
                break;
            }
            let count = target.min(self.output.len());
            let mut bytes = Vec::with_capacity(12 + count * 2);
            bytes.extend(self.sequence.to_le_bytes());
            bytes.extend(self.offset.to_le_bytes());
            bytes.extend((count as u32).to_le_bytes());
            for sample in self.output.drain(..count) {
                bytes.extend(sample.to_le_bytes());
            }
            self.sequence += 1;
            self.offset += count as u32;
            result.push(bytes);
        }
        result
    }

    pub fn finish(mut self) -> Result<Vec<Vec<u8>>, String> {
        self.process(true)?;
        Ok(self.packets(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resamples_rates_preserves_tail_and_contiguous_identity() {
        for rate in [8_000, 16_000, 44_100, 48_000, 96_000] {
            let mut pipe = Pipeline::new(rate, 2).unwrap();
            let mut packets = Vec::new();
            let frames = rate as usize * 2 + 123;
            let data: Vec<f32> = (0..frames)
                .flat_map(|i| {
                    let v = (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5;
                    [v, v]
                })
                .collect();
            for chunk in data.chunks(514) {
                packets.extend(pipe.push(chunk).unwrap());
            }
            packets.extend(pipe.finish().unwrap());
            let mut offset = 0;
            for (sequence, packet) in packets.iter().enumerate() {
                let read = |at| u32::from_le_bytes(packet[at..at + 4].try_into().unwrap());
                assert_eq!(read(0), sequence as u32);
                assert_eq!(read(4), offset);
                assert_eq!(packet.len(), 12 + read(8) as usize * 2);
                offset += read(8);
            }
            assert_eq!(offset as u64, frames as u64 * RATE as u64 / rate as u64);
            assert!(packets.iter().any(|p| p[12..].iter().any(|v| *v != 0)));
        }
    }
    #[test]
    fn rejects_invalid_format_and_never_emits_zero_length_packets() {
        assert!(Pipeline::new(0, 2).is_err());
        assert!(Pipeline::new(48_000, 0).is_err());
        assert!(Pipeline::new(16_000, 2).unwrap().push(&[0.0]).is_err());
        assert!(Pipeline::new(48_000, 1)
            .unwrap()
            .finish()
            .unwrap()
            .is_empty());
    }
}
