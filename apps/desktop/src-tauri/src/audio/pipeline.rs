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
    block: Vec<Vec<f32>>,
    resampled: Vec<Vec<f32>>,
    microphone_filter: Option<HighPass>,
    output: Vec<i16>,
    processing: Option<super::dsp::Processor>,
    received: u64,
    produced: u64,
    delay: usize,
    sequence: u32,
    offset: u32,
}

// Gentle 80 Hz Butterworth high-pass: remove rumble without gating quiet speech.
// Applied to microphone PCM only; playback and sample counts remain untouched.
struct HighPass { norm: f32, a1: f32, a2: f32, x1: f32, x2: f32, y1: f32, y2: f32 }
impl Default for HighPass {
    fn default() -> Self {
        let k = (std::f32::consts::PI * 80.0 / RATE as f32).tan();
        let norm = 1.0 / (1.0 + std::f32::consts::SQRT_2 * k + k * k);
        let a1 = 2.0 * (k * k - 1.0) * norm;
        let a2 = (1.0 - std::f32::consts::SQRT_2 * k + k * k) * norm;
        Self {norm,a1,a2,x1:0.0,x2:0.0,y1:0.0,y2:0.0}
    }
}
impl HighPass {
    fn sample(&mut self, x: f32) -> f32 {
        let y = self.norm * (x - 2.0 * self.x1 + self.x2) - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2=self.x1; self.x1=x; self.y2=self.y1; self.y1=y;
        y
    }
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
        let resampled = resampler.as_ref().map_or_else(Vec::new, |r| r.output_buffer_allocate(true));
        Ok(Self {
            rate,
            channels,
            resampler,
            input: Vec::new(),
            block: vec![vec![0.0; BLOCK]],
            resampled,
            microphone_filter: None,
            output: Vec::new(),
            received: 0,
            processing: None,
            produced: 0,
            delay,
            sequence: 0,
            offset: 0,
        })
    }

    pub fn with_microphone_filter(mut self) -> Self {
        self.microphone_filter=Some(HighPass::default());
        self
    }
    pub fn set_processing(&mut self, processor: Option<super::dsp::Processor>) {
        if self.processing.is_none() { self.processing=processor; }
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

    fn append(&mut self, samples: &[f32]) -> Result<(),String> {
        let skip = self.delay.min(samples.len());
        self.delay -= skip;
        let start=self.output.len();
        for value in &samples[skip..] {
            let value = self.microphone_filter.as_mut().map_or(*value, |filter| filter.sample(*value));
            self.output
                .push((value.clamp(-1.0, 1.0) * 32767.0).round() as i16);
            self.produced += 1;
        }
        if let Some(processor)=&mut self.processing {
            let raw=self.output.split_off(start);self.output.extend(processor.push(&raw,false)?);
        }
        Ok(())
    }

    fn process(&mut self, finish: bool) -> Result<(), String> {
        if self.resampler.is_none() {
            let input = std::mem::take(&mut self.input);
            self.append(&input)?;
            self.input=input; self.input.clear();
            return Ok(());
        }
        while self.input.len() >= BLOCK {
            self.block[0].copy_from_slice(&self.input[..BLOCK]);
            self.input.drain(..BLOCK);
            self.resample(None)?;
        }
        if finish {
            let expected = self.received * RATE as u64 / self.rate as u64;
            while self.produced < expected {
                self.block[0].fill(0.0);
                self.block[0][..self.input.len()].copy_from_slice(&self.input);
                self.input.clear();
                self.resample(Some((expected - self.produced) as usize))?;
            }
        }
        Ok(())
    }

    fn resample(&mut self, remaining: Option<usize>) -> Result<(), String> {
        let (_, written) = self.resampler.as_mut().unwrap()
            .process_into_buffer(&self.block, &mut self.resampled, None).map_err(|e| e.to_string())?;
        let output = std::mem::take(&mut self.resampled);
        let take = remaining.map_or(written, |need| written.min(self.delay.min(written) + need));
        self.append(&output[0][..take])?;
        self.resampled=output;
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

    pub fn flush(&mut self) -> Result<Vec<Vec<u8>>, String> {
        self.process(true)?;
        if let Some(processor)=&mut self.processing {self.output.extend(processor.push(&[],true)?);}
        Ok(self.packets(true))
    }
    pub fn reconfigure(&mut self, rate: u32, channels: usize) -> Result<Vec<Vec<u8>>, String> {
        let mut next = Self::new(rate, channels)?;
        let packets = self.flush()?;
        next.microphone_filter=self.microphone_filter.take();
        next.processing=self.processing.take();
        next.sequence=self.sequence;
        next.offset=self.offset;
        *self=next;
        Ok(packets)
    }
    pub fn finish(mut self) -> Result<Vec<Vec<u8>>, String> {
        self.process(true)?;
        if let Some(processor)=&mut self.processing {self.output.extend(processor.push(&[],true)?);}
        Ok(self.packets(true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dsp_preserves_packet_fences_and_short_tail_across_device_rebuild() {
        let mut pipe=Pipeline::new(48_000,2).unwrap().with_microphone_filter();
        pipe.set_processing(Some(super::super::dsp::Processor::new("pipeline-dsp",true,0).unwrap()));
        let mut packets=pipe.push(&vec![0.1;48_037*2]).unwrap();
        packets.extend(pipe.reconfigure(44_100,1).unwrap());
        packets.extend(pipe.push(&vec![0.1;44_153]).unwrap());packets.extend(pipe.finish().unwrap());
        let mut offset=0;
        for (seq,packet) in packets.iter().enumerate() {
            let read=|at|u32::from_le_bytes(packet[at..at+4].try_into().unwrap());
            assert_eq!(read(0),seq as u32);assert_eq!(read(4),offset);assert_eq!(packet.len(),12+read(8) as usize*2);offset+=read(8);
        }
        assert_eq!(offset,48_037*16_000/48_000+44_153*16_000/44_100);
    }
    #[test]
    fn format_rebuild_preserves_microphone_filter_history_without_a_new_pop() {
        for new_rate in [16_000,44_100,48_000] {
            let mut pipe=Pipeline::new(16_000,1).unwrap().with_microphone_filter();
            let mut packets=pipe.push(&vec![0.2;16_000]).unwrap();packets.extend(pipe.flush().unwrap());
            let filter=pipe.microphone_filter.as_ref().unwrap();
            let history=[filter.x1,filter.x2,filter.y1,filter.y2].map(f32::to_bits);
            packets.extend(pipe.reconfigure(new_rate,1).unwrap());
            let filter=pipe.microphone_filter.as_ref().unwrap();
            assert_eq!(history,[filter.x1,filter.x2,filter.y1,filter.y2].map(f32::to_bits));
            if new_rate==16_000 {
                let mut next=pipe.push(&vec![0.2;16_000]).unwrap();next.extend(pipe.finish().unwrap());
                assert!(next.iter().all(|packet|packet[12..].chunks_exact(2).all(|b|i16::from_le_bytes(b.try_into().unwrap()).abs()<3)));
                packets.extend(next);assert_eq!(packets.iter().map(|packet|u32::from_le_bytes(packet[8..12].try_into().unwrap())).sum::<u32>(),32_000);
            }
        }
    }
    #[test]
    fn microphone_filter_reduces_rumble_without_gating_speech_or_dropping_samples() {
        let energy=|frequency:f32| {
            let mut filter=HighPass::default(); let mut sum=0.0;
            for i in 0..32_000 { let x=(i as f32 * frequency * std::f32::consts::TAU / RATE as f32).sin()*0.1;let y=filter.sample(x);if i>=16_000 { sum+=y*y; } }
            sum/16_000.0
        };
        assert!(energy(20.0)<0.00003); // More than 22 dB rejection of low rumble.
        assert!((energy(1000.0)-0.005).abs()<0.0001);
        for rate in [8_000,16_000,44_100,48_000,96_000] {
            let mut pipe=Pipeline::new(rate,1).unwrap().with_microphone_filter();
            let mut packets=pipe.push(&vec![0.2;rate as usize+37]).unwrap();
            packets.extend(pipe.reconfigure(16_000,1).unwrap());
            assert!(pipe.microphone_filter.is_some());
            packets.extend(pipe.push(&vec![0.2;123]).unwrap());packets.extend(pipe.finish().unwrap());
            let mut offset=0;
            for (seq,packet) in packets.iter().enumerate() { let read=|at|u32::from_le_bytes(packet[at..at+4].try_into().unwrap());assert_eq!(read(0),seq as u32);assert_eq!(read(4),offset);offset+=read(8); }
            assert_eq!(offset as u64,(rate as u64+37)*16_000/rate as u64+123);
        }
    }
    #[test]
    fn format_change_preserves_tail_sequence_and_sample_offset() {
        let mut pipe=Pipeline::new(48_000,2).unwrap();
        let mut packets=pipe.push(&vec![0.25;48_000*2+246]).unwrap();
        packets.extend(pipe.reconfigure(44_100,1).unwrap());
        packets.extend(pipe.push(&vec![0.5;44_100]).unwrap());
        packets.extend(pipe.finish().unwrap());
        let mut offset=0;
        for (sequence,packet) in packets.iter().enumerate() {
            let read=|at|u32::from_le_bytes(packet[at..at+4].try_into().unwrap());
            assert_eq!(read(0),sequence as u32);assert_eq!(read(4),offset);offset+=read(8);
        }
        assert_eq!(offset,32_041);
    }
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
