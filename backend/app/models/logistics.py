from sqlalchemy import Integer, String, Float, Boolean, ForeignKey, DateTime
from sqlalchemy.orm import Mapped, mapped_column, relationship
from datetime import datetime
from app.core.db import Base


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    plate: Mapped[str] = mapped_column(String(50), default="")
    capacity_kg: Mapped[float] = mapped_column(Float, default=5000.0)
    driver_name: Mapped[str] = mapped_column(String(100), default="")
    driver_phone: Mapped[str] = mapped_column(String(50), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    shipments = relationship("Shipment", back_populates="vehicle")


class Shipment(Base):
    __tablename__ = "shipments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="planned")  # planned/dispatched/delivered
    notes: Mapped[str] = mapped_column(String(1000), default="")

    vehicle = relationship("Vehicle", back_populates="shipments")
    assignments = relationship(
        "ShipmentBrandAssignment", back_populates="shipment", cascade="all, delete-orphan"
    )


class ShipmentBrandAssignment(Base):
    __tablename__ = "shipment_brand_assignments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    shipment_id: Mapped[int] = mapped_column(ForeignKey("shipments.id"), nullable=False)
    brand: Mapped[str] = mapped_column(String(100), nullable=False)
    allocated_weight: Mapped[float] = mapped_column(Float, default=0.0)
    supplier_id: Mapped[int] = mapped_column(Integer, nullable=True)

    shipment = relationship("Shipment", back_populates="assignments")
