class PCMRecorder extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Int16Array(1600);this.index=0;this.sum=0;this.weight=0;this.ratio=sampleRate/16000;this.running=true;this.port.onmessage=e=>{if(e.data==='stop'){this.running=false;this.flush();this.port.postMessage({stopped:true});}};}
  flush(){if(this.index){const b=this.buffer.slice(0,this.index);this.port.postMessage({pcm:b.buffer},[b.buffer]);this.index=0;}}
  process(inputs){if(!this.running)return true;const input=inputs[0]?.[0];if(!input)return true;for(const value of input){let remaining=1;while(remaining>1e-8){const w=Math.min(remaining,this.ratio-this.weight);this.sum+=value*w;this.weight+=w;remaining-=w;if(this.weight>=this.ratio-1e-8){const v=Math.max(-1,Math.min(1,this.sum/this.ratio));this.buffer[this.index++]=Math.round(v*(v<0?32768:32767));this.sum=0;this.weight=0;if(this.index===this.buffer.length)this.flush();}}}return true;}
}
registerProcessor('pcm-recorder',PCMRecorder);
