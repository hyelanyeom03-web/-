export interface JoystickData {
  x: number; // -1 to 1 (left to right)
  y: number; // -1 to 1 (up to down: -1 is forward/up, 1 is backward/down)
  angle: number; // 0 to 360 deg
  distance: number; // 0 to 1 (force)
  active: boolean;
}

export interface ButtonStates {
  boost: boolean;
  action: boolean;
  jump: boolean;
  light: boolean;
}

export interface GyroData {
  alpha: number;
  beta: number;
  gamma: number;
  active: boolean;
}

export interface ControllerPayload {
  joystick: JoystickData;
  buttons: ButtonStates;
  gyro?: GyroData;
  timestamp: number;
}

export interface ControllerPacket {
  type: 'controller_input';
  controllerId: string;
  name: string;
  color: string;
  payload: ControllerPayload;
  timestamp: number;
}

export interface ConnectedPeer {
  id: string;
  name?: string;
  color?: string;
  role: 'host' | 'controller';
  joinedAt: number;
  lastPing?: number;
}
